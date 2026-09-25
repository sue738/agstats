'use strict';
/** Public API: the readers and the normalised model, plus every metric. */
module.exports = {
  brand: require('./lib/brand.js'),
  model: require('./lib/model.js'),
  dialogue: require('./lib/dialogue.js'),
  wire: require('./lib/wire.js'),
  readers: require('./lib/readers/index.js'),
  render: require('./lib/render.js'),
  metrics: {
    hours: require('./lib/metrics/hours.js'),
    tools: require('./lib/metrics/tools.js'),
    blast: require('./lib/metrics/blast.js'),
    leaks: require('./lib/metrics/leaks.js'),
    stats: require('./lib/metrics/stats.js'),
    timeline: require('./lib/metrics/timeline.js'),
    quota: require('./lib/metrics/quota.js'),
    diff: require('./lib/metrics/diff.js'),
    skills: require('./lib/metrics/skills.js'),
    attention: require('./lib/metrics/attention.js'),
    guards: require('./lib/metrics/guards.js'),
    advise: require('./lib/metrics/advise.js'),
    overlap: require('./lib/metrics/overlap.js'),
    waits: require('./lib/metrics/waits.js'),
    sends: require('./lib/metrics/sends.js'),
  },
};
