/* Minimal call-function plugin for jsPsych 8: runs func() and stores the returned object's fields in the trial data
   (the official plugin stores the return value as `value`).
   async = true: func(done) is called with a callback, and the trial ends only when func calls done(result). This is
   how experiment.html waits for DataPipe's condition assignment after consent. A message can be shown meanwhile. */
var jsPsychCallFunction = (function (jspsych) {
  "use strict";
  const info = { name: "call-function", version: "1.1.0",
    parameters: { func: { type: jspsych.ParameterType.FUNCTION, default: undefined },
                  async: { type: jspsych.ParameterType.BOOL, default: false },
                  waiting_message: { type: jspsych.ParameterType.HTML_STRING, default: "" } }, data: {} };
  class P { constructor(j) { this.jsPsych = j; }
    trial(el, trial) {
      let ended = false;
      const fin = (v) => { if (ended) return; ended = true; el.innerHTML = "";
        this.jsPsych.finishTrial(v && typeof v === "object" ? v : { value: v }); };
      if (trial.async) { el.innerHTML = trial.waiting_message || ""; trial.func(fin); }
      else fin(trial.func());
    } }
  P.info = info; return P;
})(jsPsychModule);
