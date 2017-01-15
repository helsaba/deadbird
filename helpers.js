require('colors');
const async    = require('async');
const moment   = require('moment');
const utils    = require('./utils')
const schedule = require('node-schedule');
const spawn    = require('child_process').spawn;
const settings = utils.settings;

const db     = require('./models/db');
const Tweet  = require('./models/tweet');
const Handle = require('./models/handle');

let tty = process.stdout.isTTY ? true : false;

const charm = require('charm')();

if (tty) {
  charm.pipe(process.stdout);
  charm.cursor(false);
}

let helpers = {
  // Cache the index stream pages
  cacheIndex(cb=()=>{}) {
    let cache = {
      index: {
        '1': {tweets: [], totalTweets: 0}
      }
    };

    Tweet.getAllDeleted(null).then(data => {
      let total = data.total;
      let totalPages = Math.ceil(total/25);

      let count = 0;
      async.whilst(
        function() { return count < totalPages; },
        function(innercb) {
          getPage(++count, innercb.bind(this, null, count));
        },
        function (err, n) {
          utils.set('cache', cache);
          cb();
        }
      );
    });

    function getPage(page, cb) {
      let tweets, totalTweets;
      async.parallel([
        cb => Tweet.getAllDeleted((page*25)-25).then(data => {
          tweets = data.tweets;
          totalTweets = data.total;
          cb();
        })
      ], () => {
        let tweetData = [];

        async.eachLimit(tweets, 1, (tweet, cb) => {
          Tweet.getTweetTxt(tweet.tweetid).then(data => {
            tweetData.push(data);
            cb();
          });
        }, () => {
          cache.index[page] = {tweets: tweetData, totalTweets};
          cb();
        });
      });
    }
  },
  updateStats(cb=()=>{}) {
    let start = new Date().getTime();
    let stats = {};
    Handle.getAll().then(handles => {
      handles.unshift(null);

      async.eachLimit(handles, 50, (handle, cb) => {
        getStats(handle ? handle.id : null).then(stat => {
          stats[handle ? handle.id : "all"] = stat;
          cb();
        });
      }, () => {
        utils.set('stats', stats);
        utils.set('statUpdate', new Date().getTime());
        utils.set('dates', JSON.parse(JSON.stringify(stats['all'])).map((val, ind)=>moment(val.date.slice(0, 0-14)).format('Y/MM/DD')).reverse());
        cb();
      });
    });

    function getStats(handle=null) {
      return new Promise((resolve, reject) => {
        let data = [];
        let count = 0;

        async.whilst(
          () => count < 30,
          cb => {
            daysAgo(count, handle).then(row => {
              count++;
              data.push(row[0]);
              cb(null)
            });
          },
          resolve.bind(this, data)
        );
      });

      function daysAgo(days, handle=null) {
        return new Promise((resolve, reject) => {
          if (days === 0) {
            query = `SELECT (SELECT curdate()) AS date,(SELECT COUNT(*) FROM tweets WHERE deletedate >= curdate()${handle ? " AND handle = " + handle : ""}) AS deleted, (SELECT COUNT(*) FROM tweets WHERE date >= curdate()${handle ? " AND handle = " + handle : ""}) AS added`;
          } else {
            query = `SELECT (SELECT DATE_SUB(curdate(), INTERVAL ${days} DAY)) AS date,(SELECT COUNT(*) FROM tweets WHERE DATE(deletedate) = DATE_SUB(curdate(), INTERVAL ${days} DAY)${handle ? " AND handle = " + handle : ""}) AS deleted, (SELECT COUNT(*) FROM tweets WHERE DATE(date) = (SELECT CURDATE() - INTERVAL ${days} DAY)${handle ? " AND handle = " + handle : ""}) AS added`;
          }
          db.connection.query(query, (err, data) => resolve(data));
        });
      }
    }
  },
  initStats() {
    let data = {
      fetcher: {percent: 0},
      refetcher: {percent: 0},
      checker: {percent: 0},
      unchecker: {percent: 0},
      template: {percent: 0}
    };

    let cacheData = {
      stats: {status: 'pre'},
      index: {status: 'pre'},
      statsStream: {status: 'pre'}
    };

    let cacheStatus, cacheItem = 'stats';

    utils.set('data', data);

    async.series([
      // Start template -> checker
      cb => {
        let liveStatus, item = 'template';
        if (settings.general.retrieversEnabled) {
          async.series([
            cb => {
              console.log("\n\n\n\n\n");
              cb();
            },
            cb => {
              liveStatus = setInterval(() => {
                liveStatusUpdate(data, item);
              }, 100);
              cb();
            },
            cb => {
              spawner('template').then(() => {
                cb()
              });
            },
            cb => {
              item = 'fetcher';
              spawner('fetcher').then(cb.bind(this));
            },
            cb => {
              item = 'refetcher';
              spawner('refetcher').then(cb.bind(this));
            },
            cb => {
              item = 'unchecker';
              spawner('unchecker').then(cb.bind(this));
            },
            cb => {
              item = 'checker';
              spawner('checker').then(cb.bind(this));
            }
          ], () => {
            clearInterval(liveStatus);
            liveStatusUpdate(data, item);
            console.log();

            setTimeout(fetcherLoop,   settings.general.fetcherRestInterval * 1000);
            setTimeout(refetcherLoop, settings.general.refetcherRestInterval * 1000);
            setTimeout(templateLoop,  settings.general.templateRestInterval * 1000);
            setTimeout(uncheckerLoop, settings.general.fetcherRestInterval * 1000);
            setTimeout(checkerLoop,   settings.general.checkerRestInterval * 1000);
            cb();
          });
        } else {
          cb();
        }
      },

      // Cache stats for graphs
      cb => {
        console.log("\n\n\n");
        cacheStatus = setInterval(() => {
          cacheStatusUpdate(cacheData, cacheItem);
        }, 100);
        cb();
      },
      cb => {
        cacheData.stats.status = 'inProgress';
        helpers.updateStats(() => {
          cacheData.stats.status = 'done';
          schedule.scheduleJob('0 */15 * * * *', helpers.updateStats);
          cb();
        });
      },

      cb => {
        cacheItem = 'index';
        cacheData.index.status = 'inProgress';
        utils.emit("indexCacherStart");
        utils.once("indexCacherDone", () => {
          cacheData.index.status = 'done';
          cb();
        });
      },

      cb => {
        cacheItem = 'statsStream';
        cacheData.statsStream.status = 'inProgress';
        utils.emit("statsStreamCacherStart");
        utils.once("statsStreamCacherDone", () => {
          cacheData.statsStream.status = 'done';
          cb();
        });
      }

    // Prep is done, we can now start the server
    ], () => {
      clearInterval(cacheStatus);
      cacheStatusUpdate(cacheData, cacheItem);
      console.log();

      utils.emit('initStatsDone');
    });
  },
  updateAutoComplete(cb) {
    Handle.getAll().then(data => {
      utils.set('autocomplete', JSON.stringify(data.map(item => item.handle.toLowerCase())));
      cb();
    });
  },
  cacheStatsStream(cb=()=>{}) {
    let cache = {};

    async.eachLimit(utils.get('dates'), 1, (date, cb) => {

      let page = 1;
      let totalPages = +Infinity;
      async.whilst(
        function() { return page <= totalPages; },
        function(innercb) {

          let tweets, totalTweets;
          async.parallel([
            cb => Tweet.getDeletedTweetsDate(null, date, page).then(data => {
              tweets      = data.tweets;
              totalTweets = data.total;
              if (totalPages === +Infinity) {
                totalPages = Math.ceil(totalTweets/25);
              }
              cb();
            })
          ], err => {
            let tweetData = [];

            async.eachLimit(tweets, 1, (tweet, cb) => {
              Tweet.getTweetTxt(tweet.tweetid).then(data => {
                tweetData.push(data);
                cb();
              });
            }, () => {
              if (cache[date] === undefined) cache[date] = {};
              cache[date][page] = {tweets: tweetData, totalTweets};
              page++;
              innercb();
            });
          });

        },
        function (err, n) {
          cb();
        }
      );

    }, () => {
      utils.set('statsStream', cache);
      cb();
    });
  }
};

// Spawners //
function spawner(mode) {
  let data = utils.get('data');
  let scripts = {fetcher: 'fetch', refetcher: 'refetcher', unchecker: 'unchecker', checker: 'check', template: 'getTemplate'};

  return new Promise((resolve, reject) => {
    data[mode] = {percent: 0};

    let spawned;
    if (settings.general.limitedRam) {
      spawned = spawn('node', ['--expose-gc', scripts[mode]]);
    } else {
      spawned = spawn('node', [scripts[mode]]);
    }

    spawned.stdout.on('data', out => {
      // Sometimes the JSON output is garbled because of two
      // objects outputting at the same time.
      try {
        out = JSON.parse(out);
      } catch(e) {
        return;
      }

      populate(data, mode, out, [
        'status', 'percent', 'remaining', 'rate',
        'eta', 'user', 'url', 'text'
      ]);
    });

    spawned.on('exit', err => {
      let text = data[mode].text;
      data[mode] = {text, percent: 100};
      if (err === null) resolve(true);
      else resolve(false);
    });

    function populate(data, mode, out, items) {
      items.forEach(item => {
        if (item in out) data[mode][item] = out[item];
      });
    }
  });
}

function checkerLoop() {
  let data = utils.get('data');

  spawner('checker').then(fail => {
    if (fail) checkerLoop();
    else {
      data['checker'].nextCheck = new Date().getTime() + settings.general.checkerRestInterval * 1000;
      utils.emit("indexCacherStart");
      utils.emit("statsStreamCacherStart");
      setTimeout(checkerLoop, settings.general.checkerRestInterval * 1000);
    }
  });
}

function uncheckerLoop() {
  let data = utils.get('data');

  spawner('unchecker').then(fail => {
    if (fail) uncheckerLoop();
    else {
      data['unchecker'].nextCheck = new Date().getTime() + settings.general.uncheckerRestInterval * 1000;
      setTimeout(uncheckerLoop, settings.general.uncheckerRestInterval * 1000);
    }
  });
}

function fetcherLoop() {
  let data = utils.get('data');

  spawner('fetcher').then(fail => {
    if (fail) fetcherLoop();
    else {
      data['fetcher'].nextCheck = new Date().getTime() + settings.general.fetcherRestInterval * 1000;
      setTimeout(fetcherLoop, settings.general.fetcherRestInterval * 1000);
    }
  });
}

function refetcherLoop() {
  let data = utils.get('data');

  spawner('refetcher').then(fail => {
    if (fail) refetcherLoop();
    else {
      data['refetcher'].nextCheck = new Date().getTime() + settings.general.refetcherRestInterval * 1000;
      setTimeout(refetcherLoop, settings.general.refetcherRestInterval * 1000);
    }
  });
}

function templateLoop() {
  let data = utils.get('data');

  spawner('template').then(fail => {
    if (fail) templateLoop();
    else {
      data['template'].nextCheck = new Date().getTime() + settings.general.templateRestInterval * 1000;
      setTimeout(templateLoop, settings.general.templateRestInterval * 1000);
    }
  });
}

function liveStatusUpdate(data, item) {
  charm.up(6);
  let strings = [
    {val: `[1 / 5] Template Fetcher ${data.template.percent}%`,  percent: data.template.percent},
    {val: `[2 / 5] Fetcher          ${data.fetcher.percent}%`,   percent: data.fetcher.percent},
    {val: `[3 / 5] Refetcher        ${data.refetcher.percent}%`, percent: data.refetcher.percent},
    {val: `[4 / 5] Unchecker        ${data.unchecker.percent}%`, percent: data.unchecker.percent},
    {val: `[5 / 5] Checker          ${data.checker.percent}%`,   percent: data.checker.percent}
  ];
  console.log(`--- Deadbird initial setup ---`.bold);
  strings.forEach(str => {
    if (str.percent > 0 && str.percent < 100) console.log(str.val.yellow)
    else if (str.percent === 100) console.log(str.val.green)
    else console.log(str.val);
  });
}

function cacheStatusUpdate(cacheData, item) {
  let progress = {
    stats: 0,
    index: 0,
    statsStream: 0
  };

  cacheStatusUpdate = (cacheData, item) => {
    progress[item]++;
    charm.up(4);
    let strings = [
      {val: `[1 / 3]  Graph stats`, item: 'stats'},
      {val: `[2 / 3]        Index`, item: 'index'},
      {val: `[3 / 3] Stats Stream`, item: 'statsStream'}
    ];
    console.log(`--- Deadbird caching setup ---`.bold);
    strings.forEach(str => {
      let line = str.val + ".".repeat(progress[str.item]/2);
      if (cacheData[str.item].status === 'done') {
        console.log(line.green);
      } else if (cacheData[str.item].status === 'inProgress') {
        console.log(line.yellow);
      } else {
        console.log(line);
      }
    });
  }
  cacheStatusUpdate(cacheData, item);
}

module.exports = helpers;
