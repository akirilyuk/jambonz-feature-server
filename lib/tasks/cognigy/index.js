const Task = require('../task');
const {TaskName, TaskPreconditions} = require('../../utils/constants');
const makeTask = require('../make_task');
const { SocketClient } = require('@cognigy/socket-client');
const SpeechConfig = require('./speech-config');
const queue = require('queue');

const parseGallery = (obj = {}) => {
  const {_default} = obj;
  if (_default) {
    const {_gallery} = _default;
    if (_gallery) return _gallery.fallbackText;
  }
};

const parseQuickReplies = (obj) => {
  const {_default} = obj;
  if (_default) {
    const {_quickReplies} = _default;
    if (_quickReplies) return _quickReplies.text || _quickReplies.fallbackText;
  }
};

const parseBotText = (evt) => {
  const {text, data} = evt;
  if (text !== undefined) return String(text);

  switch (data?.type) {
    case 'quickReplies':
      return parseQuickReplies(data?._cognigy);
    case 'gallery':
      return parseGallery(data?._cognigy);
    default:
      break;
  }
};

class Cognigy extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.url = this.data.url;
    this.token = this.data.token;
    this.prompt = this.data.prompt;
    this.eventHook = this.data?.eventHook;
    this.actionHook = this.data?.actionHook;
    this.data = this.data.data || {};
    this.prompts = [];
    this.retry = {};
    this.timeoutCount = 0;
    // create a task queue so we can execute our taskss subsequently
    // also executing tasks whenever they come in
    this.taskQueue = queue({concurrency: 1, autostart: 1});

    // keep track of turns so we only do gather once per turn
    this.turn = 0;
    this.gatherTurn = 0;
  }

  get name() { return TaskName.Cognigy; }

  get hasReportedFinalAction() {
    return this.reportedFinalAction || this.isReplacingApplication;
  }

  async _enqueueTask(task) {
    let resolver;
    let rejector;

    const boundTask = task.bind(this);
    const taskPromise = new Promise(async(resolve, reject) => {
      resolver = resolve;
      rejector = reject;
    });
    taskPromise.resolve = resolver;
    this.taskQueue.push(async(cb) => {
      this.logger.debug('executing task from queue');
      try {
        const result = await boundTask();
        resolver(result);
        cb(result);
      } catch (err) {
        this.logger.error({err}, 'could not execute task in task queue');
        rejector(err);
        cb(err);
      }
      this.logger.debug('say task executed from queue');
    });
    if(this.taskQueue.lastPromise){
      // resolve the previous promise for cleanup
      this.taskQueue.lastPromise.resolve({});
    }
    this.taskQueue.lastPromise = taskPromise;
    return taskPromise;
  }

  async exec(cs, ep) {
    await super.exec(cs);

    const opts = {
      session: {
        synthesizer: this.data.synthesizer || {
          vendor: 'default',
          language: 'default',
          voice: 'default'
        },
        recognizer: this.data.recognizer || {
          vendor: 'default',
          language: 'default'
        },
        bargein: this.data.bargein || {},
        bot: this.data.bot || {},
        user: this.data.user || {},
        dtmf: this.data.dtmf || {}
      }
    };
    this.config = new SpeechConfig({logger: this.logger, ep, opts});
    this.ep = ep;
    try {

      /* set event handlers and start transcribing */
      this.on('transcription', this._onTranscription.bind(this, cs, ep));
      this.on('dtmf-collected', this._onDtmf.bind(this, cs, ep));
      this.on('timeout', this._onTimeout.bind(this, cs, ep));
      this.on('error', this._onError.bind(this, cs, ep));

      /* connect to the bot and send initial data */
      this.client = new SocketClient(
        this.url,
        this.token,
        {
          sessionId: cs.callSid,
          channel: 'jambonz',
          forceWebsockets: true,
          reconnection: true,
          settings: {
            enableTypingIndicator: false
          }
        }
      );
      this.client.on('output', this._onBotUtterance.bind(this, cs, ep));
      this.client.on('error', this._onBotError.bind(this, cs, ep));
      this.client.on('finalPing', this._onBotFinalPing.bind(this, cs, ep));
      await this.client.connect();
      // todo make welcome message configurable (enable or disable it when
      // we start a conversation (should be enabled by defaul))
      this.client.sendMessage('Welcome Message', {...this.data, ...cs.callInfo});

      await this.awaitTaskDone();
    } catch (err) {
      this.logger.error({err}, 'Cognigy error');
      throw err;
    }
  }

  async kill(cs) {
    super.kill(cs);
    this.logger.debug('Cognigy:kill');


    this.removeAllListeners();
    this.transcribeTask && this.transcribeTask.kill();

    this.client.removeAllListeners();
    if (this.client && this.client.connected) this.client.disconnect();

    try {
      // end the task queue AFTER we have removed all listeneres since now we cannot get new stuff inside the queue
      this.taskQueue.end();
    } catch (err) {
      this.logger.error({err}, 'could not end tasks queue!!');
    }


    if (!this.hasReportedFinalAction) {
      this.reportedFinalAction = true;
      this.performAction({cognigyResult: 'caller hungup'})
        .catch((err) => this.logger.info({err}, 'cognigy - error w/ action webook'));
    }

    if (this.ep.connected) {
      await this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
    this.notifyTaskDone();
  }

  /**
   * Creates a promt which will be sent to the consumer. We will create a say task if bargein is disabled
   * for session and nextTurn, else create a gather task.
   */
  _createPromtTask({text, url, turnConfig, dontListenAfterSpeech} = {}){
    const bargeInOnNextTurn = turnConfig?.bargein?.enable?.length>0;
    const bargeInSession = this.config.bargeInEnabled;
    if(bargeInOnNextTurn || bargeInSession){
      return this._makeGatherTask({textPrompt: text, url: urlPrompt, turnConfig, dontListenAfterSpeech});
    }
    return this._makeSayTask({text, turnConfig});
  }

  _makeGatherTask({textPrompt, urlPrompt, turnConfig} = {}) {
    this.logger.debug({textPrompt, urlPrompt, turnConfig}, '_makeGatherTask');
    const config = this.config.makeGatherTaskConfig({textPrompt, urlPrompt, turnConfig});
    const {retry, ...rest} = config;
    this.retry = retry;
    const gather = makeTask(this.logger, {gather: rest}, this);
    return gather;
  }

  _makeSayTask({ text, turnConfig } = {}) {
    this.logger.debug({text, turnConfig}, '_makeSayTask');
    const config = this.config.makeSayTaskConfig({text, turnConfig });
    this.logger.debug({config}, "created say task config");
    const say = makeTask(this.logger, { say: config }, this);
    return say;
  }

  _makeReferTask(referTo) {
    return makeTask(this.logger, {'sip:refer': {
      referTo
    }}
    );
  }

  _makeHangupTask(reason) {
    return makeTask(this.logger,  {
      hangup: {
        headers: {
          'X-Reason': reason
        }
      }});
  }

  _makePlayTask(url, loop) {
    return makeTask(this.logger, {
      play: {
        url,
        loop
      }
    });
  }

  /* if we need to interrupt the currently-running say task(s), call this */
  _killSayTasks(ep) {
    // this will also remove all other upcoming tasks after the say task
    // maybe we need a flow to kill only one say tasks and keep others executitng need to discuss this further
    // this.taskQueue.end();
    if (ep && ep.connected) {
      ep.api('uuid_break', this.ep.uuid)
        .catch((err) => this.logger.info({err}, 'Cognigy:_killSayTasks - error killing audio for current say task'));
    }
  }

  async _onBotError(cs, ep, evt) {
    this.logger.info({evt}, 'Cognigy:_onBotError');
    this.performAction({cognigyResult: 'botError', message: evt.message });
    this.reportedFinalAction = true;
    this.notifyTaskDone();
  }

  async _onBotFinalPing(cs, ep) {
    this.logger.info({prompts: this.prompts}, 'Cognigy:_onBotFinalPing');
    try {
      // lets wait until we have finished processing the speech before 
      // starting a gather...
      await this.taskQueue.lastPromise;
      const gatherTask = this._makeGatherTask();
      await gatherTask.exec(cs, ep, this);
    } catch (err) {
      this.logger.info({err}, 'Cognigy gather task returned error');
    }
  }

  async _onBotUtterance(cs, ep, evt) {
    this.logger.debug({evt}, 'Cognigy:_onBotUtterance');

    if (this.eventHook) {
      this.performHook(cs, this.eventHook, {event: 'botMessage', message: evt})
        .then((redirected) => {
          if (redirected) {
            this.logger.info('Cognigy_onBotUtterance: event handler for bot message redirected us to new webhook');
            this.reportedFinalAction = true;
            this.performAction({cognigyResult: 'redirect'}, false);
          }
          return;
        })
        .catch(({err}) => {
          this.logger.info({err}, 'Cognigy_onBotUtterance: error sending event hook');
        });
    }

    const text = parseBotText(evt);

    // only add say task if its a normal cognigy node and not a "gather task"
    if (text && (evt?.data?.type !== 'promt')) {
      this.logger.info({text}, 'received text');
      this._enqueueTask(async() => {
        // todo inject the session config into the say task
        const sayTask = this._createPromtTask({ text, dontListenAfterSpeech: true });
        await sayTask.exec(cs, ep, this);
        this.logger.debug({text}, 'executed say task');
      });
    }


    try {
      switch (evt?.data?.type) {
        case 'hangup':
          this._enqueueTask(async() => {
            this.performAction({cognigyResult: 'hangup Succeeded'});
            this.reportedFinalAction = true;
            cs.replaceApplication([this._makeHangupTask(evt.data.reason)]);
            this.taskQueue.end();
          });
          return;
        case 'refer':
          this._enqueueTask(async() => {
            this.performAction({cognigyResult: 'refer succeeded'});
            this.reportedFinalAction = true;
            cs.replaceApplication([this._makeReferTask(evt.data.referTo)]);
          });
          return;
        case 'promt':
          this._enqueueTask(async() => {
            const sayTask = this._createPromtTask({
              text: evt.data.text,
              turnConfig: evt?.data?.config?.nextTurn
            });
            try {
              await sayTask.exec(cs, ep, this);
            } catch (err) {
              this.logger.info({err}, 'Cognigy sayTask task returned error');
            }
          });
          return;
        case 'setSessionConfig':
          // change session params in the order they come in with the say tasks
          // so we are consistent with the flow logic executed within cognigy
          this._enqueueTask(async() => {
            if (evt?.data?.config?.session) this.config.update(evt.data.config.session);
          });
          return;
        default:
          break;
      }
    } catch (err) {
      this.logger.info({err, evtData: evt.data}, 'encountered error parsing cognigy response data');
      if (!this.hasReportedFinalAction) this.performAction({cognigyResult: 'error', err});
      this.reportedFinalAction = true;
      this.notifyTaskDone();
    }
  }

  async _onTranscription(cs, ep, evt) {
    this.logger.debug({evt}, `Cognigy: got transcription for callSid ${cs.callSid}`);
    const utterance = evt.alternatives[0].transcript;

    //if we have barge in enabled AND we enabled skipping until next question
    //then stop execution of currently queues bot output before sending the 
    //response to waiting bot since otherwise we could stop upcoming bot output

    if(this.config.skipUntilBotInput){
      // clear task queue, resolve the last promise and cleanup;
      this.taskQueue.end();
      this.taskQueue.lastPromise.resolve();
      this.taskQueue.autostart = true;
    }

    if (this.eventHook) {
      this.performHook(cs, this.eventHook, {event: 'userMessage', message: utterance})
        .then((redirected) => {
          if (redirected) {
            this.logger.info('Cognigy_onTranscription: event handler for user message redirected us to new webhook');
            this.reportedFinalAction = true;
            this.performAction({cognigyResult: 'redirect'}, false);
            if (this.transcribeTask) this.transcribeTask.kill(cs);
          }
          return;
        })
        .catch(({err}) => {
          this.logger.info({err}, 'Cognigy_onTranscription: error sending event hook');
        });
    }

    /* send the user utterance to the bot */
    try {
      if (this.client && this.client.connected) {
        this.client.sendMessage(utterance);
      }
      else {
        // if the bot is not connected, should we maybe throw an error here?
        this.logger.info('Cognigy_onTranscription - not sending user utterance as bot is disconnected');
      }
    } catch (err) {
      this.logger.error({err}, 'Cognigy_onTranscription: Error sending user utterance to Cognigy - ending task');
      this.performAction({cognigyResult: 'socketError'});
      this.reportedFinalAction = true;
      this.notifyTaskDone();
    }
  }

  _onDtmf(cs, ep, evt) {
    this.logger.info({evt}, 'got dtmf');

    /* send dtmf to bot */
    try {
      if (this.client && this.client.connected) {
        this.client.sendMessage(String(evt.digits));
      }
      else {
        // if the bot is not connected, should we maybe throw an error here?
        this.logger.info('Cognigy_onTranscription - not sending user dtmf as bot is disconnected');
      }
    } catch (err) {
      this.logger.error({err}, '_onDtmf: Error sending user dtmf to Cognigy - ending task');
      this.performAction({cognigyResult: 'socketError'});
      this.reportedFinalAction = true;
      this.notifyTaskDone();
    }
  }
  _onError(cs, ep, err) {
    this.logger.info({err}, 'Cognigy: got error');
    if (!this.hasReportedFinalAction) this.performAction({cognigyResult: 'error', err});
    this.reportedFinalAction = true;
    this.notifyTaskDone();
  }

  _onTimeout(cs, ep, evt) {
    const {noInputRetries, noInputSpeech, noInputUrl} = this.retry;
    this.logger.debug({evt, retry: this.retry}, 'Cognigy: got timeout');
    if (noInputRetries && this.timeoutCount++ < noInputRetries) {
      const gatherTask = this._makeGatherTask({textPrompt: noInputSpeech, urlPrompt: noInputUrl});
      gatherTask.exec(cs, ep, this)
        .catch((err) => this.logger.info({err}, 'Cognigy gather task returned error'));
    }
    else {
      if (!this.hasReportedFinalAction) this.performAction({cognigyResult: 'timeout'});
      this.reportedFinalAction = true;
      this.notifyTaskDone();
    }
  }
}

module.exports = Cognigy;