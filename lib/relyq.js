// relyq
// A reliable task queue

// builtin
var util = require('util'),
  EventEmitter = require('events').EventEmitter;

// vendor
var async = require('async'),
  _ = require('underscore'),
  simpleq = require('simpleq'),
  uuid = require('uuid');

// local
var DeferredTaskList = require('./deferred'),
  RecurringTaskList = require('./recurring');

// -- Master Type: Q --
// The master type, a task queue
function Q(redis, preopts) {
  // handle forgetting a 'new'
  if (!(this instanceof Q)) {
    return new Q(redis, preopts);
  }

  if (preopts === undefined) preopts = redis, redis = preopts.redis;

  if (!redis && preopts.createRedis) {
    this._redis = redis = preopts.createRedis()
  } else {
    console.error('WARNING: passing a redis instance to relyq is deprecated. Please pass options.createRedis() function.')
    this._redis = redis
  }

  this._options = typeof preopts === 'string' ? {prefix: preopts, redis: redis} : preopts
  this._delimeter = preopts.delimeter || ':';

  this._idfield = preopts.idfield || 'id';
  this._prefix = preopts.prefix || preopts;
  this._clean_finish = preopts.clean_finish === undefined || preopts.clean_finish;
  this._keep_storage = preopts.clean_finish === 'keep_storage';

  this.todo = new simpleq.Q(redis, this._prefix + this._delimeter + 'todo');
  this.doing = new simpleq.Q(redis, this._prefix + this._delimeter + 'doing');
  this.failed = new simpleq.Q(redis, this._prefix + this._delimeter + 'failed');
  if (!this._clean_finish) {
    this.done = new simpleq.Q(redis, this._prefix + this._delimeter + 'done');
  }

  if (preopts.allow_defer && preopts.createRedis) {
    this.deferred = new DeferredTaskList(this, {
      polling_interval: preopts.defer_polling_interval,
      key: this._prefix + this._delimeter + 'deferred',
      redis: preopts.createRedis(),
    });
  }
  if (preopts.allow_recur && preopts.createRedis) {
    this.recurring = new RecurringTaskList(this, {
      polling_interval: preopts.recur_polling_interval,
      key: this._prefix + this._delimeter + 'recurring',
      redis: preopts.createRedis(),
    });
  }

  EventEmitter.call(this);

  var rq = this;
  if (this._redis.ready) {
    setImmediate(function () {
      rq.emit('ready')
    })
  } else {
    this._redis.once('ready', function () {
      rq.emit('ready')
    })
  }
}

util.inherits(Q, EventEmitter);

// @overridable
// Get a task object from its object
Q.prototype.get = function get(taskref, callback) {
  callback(null, taskref);
};

// @overridable
// Set a task object and return its reference ID
Q.prototype.set = function set(taskobj, taskref, callback) {
  callback();
};

// @overridable
// Delete the task obj and return its reference ID
Q.prototype.del = function del(taskref, callback) {
  callback();
};

// End the listeners that might be listening
Q.prototype.end = function (callback) {
  var redis = this._redis
  if (this.deferred) {
    this.deferred.end();
  }
  if (this.recurring) {
    this.recurring.end();
  }
  if (this._sql) {
    this._sql.once('end', cb).end();
  } else {
    cb();
  }
  function cb(err) {
    redis.end();
    callback(err);
  }
}

// -- Superclass methods ---

// refs get put into the queue
Q.prototype.ref = function (task) {
  return task[this._idfield] || (task[this._idfield] = uuid.v4());
};

Q.prototype.getclean = function getclean(taskref, callback) {
  var self = this;

  async.waterfall([
    _.bind(this.get, this, taskref),
    function (taskobj, cb) {
      delete(taskobj[self._idfield]);
      cb(null, taskobj);
    }
  ], callback);
}

Q.prototype.push = function push(task, callback) {
  var ref = this.ref(task);
  async.parallel([
    _.bind(this.set, this, task, ref),
    _.bind(this.todo.push, this.todo, ref)
  ], function (err, results) {
    callback(err, results && results.length === 2 && results[1]);
  });
};

Q.prototype.defer = function defer(task, when, callback) {
  if (!this.deferred) {
    throw new Error('Must use option allow_defer to allow defer calls.');
  }

  var ref = this.ref(task);
  async.parallel([
    _.bind(this.set, this, task, ref),
    _.bind(this.deferred.defer, this.deferred, ref, when),
  ], function (err, results) {
    callback(err, results && results.length === 2 && results[1]);
  });
};

// Remove from deferred list and delete
Q.prototype.undefer_remove = function undefer_remove(taskref, callback) {
  if (!this.deferred) {
    throw new Error('Must use option allow_defer to allow undefer calls.');
  }

  async.parallel([
    _.bind(this.del, this, taskref),
    _.bind(this.deferred.eliminate, this.deferred, taskref),
  ], function (err, results) {
    callback(err, results && results.length === 2 && results[1]);
  });
};

// Remove from deferred list and immediately process
Q.prototype.undefer_push = function undefer_push(taskref, callback) {
  if (!this.deferred) {
    throw new Error('Must use option allow_defer to allow undefer calls.');
  }

  this.deferred.immediate(taskref, callback)
};

Q.prototype.recur = function recur(task, every, callback) {
  if (!this.recurring) {
    throw new Error('Must use option allow_recur to allow recur calls.');
  }

  var ref = this.ref(task);
  async.parallel([
    _.bind(this.set, this, task, ref),
    _.bind(this.recurring.recur, this.recurring, ref, every),
  ], function (err, results) {
    callback(err, results && results.length === 2 && results[1]);
  });
};

Q.prototype.process = function process(callback) {
  async.waterfall([
    _.bind(this.todo.poppipe, this.todo, this.doing),
    _.bind(this.get, this)
  ], callback);
};

Q.prototype.bprocess = function bprocess(timeout, callback) {
  if (callback === undefined) {
    callback = timeout;
    timeout = 0;
  }

  async.waterfall([
    _.bind(this.todo.bpoppipe, this.todo, this.doing, timeout),
    _.bind(this.get, this)
  ], callback);
};

Q.prototype.finish = function finish() {
  if (this._clean_finish) {
    this._finish_clean.apply(this, arguments);
  } else {
    this._finish_dirty.apply(this, arguments);
  }
};


Q.prototype.fail = function fail(task, optional_error, callback) {
  if (callback === undefined) callback = optional_error, optional_error = undefined;
  if (optional_error) task.error = optional_error instanceof Error ? optional_error.stack : optional_error;

  var ref = this.ref(task);
  async.parallel([
    _.bind(this.set, this, task, ref),
    _.bind(this.doing.spullpipe, this.doing, this.failed, ref)
  ], function (err, results) {
    if (err) {
      return callback(err);
    }
    if (results && results[1] === 0) {
      return callback(new Error('Element ' + (_.isObject(task) ? JSON.stringify(task) : task.toString()) + ' is not currently processing.'));
    }
    callback(null, results[1]);
  });
};

Q.prototype.remove = function remove(from, task, dontdel, callback) {
  if (callback === undefined) {
    callback = dontdel;
    dontdel = false;
  }
  var ref = this.ref(task);

  if (dontdel) {
    return this[from].pull(ref, callback);
  }

  async.parallel([
    _.bind(this.del, this, ref),
    _.bind(this[from].pull, this[from], ref)
  ], function (err, results) {
    callback(err, results && results.length === 2 && results[1]);
  });
};

// Start a process listener
/*
Example Usage

    var listener = rq.listen({
      max_out: 10, // maximum tasks to emit at one time
    })
      .on('error', function (err, optional_taskref) {
        if (taskref) {...}
        else {...}
      })
      .on('task', function (task, done) {
        // do task
        done(error_or_not); // This will call rq.fail or rq.finish!
      });

    // some time later
    listener.end();
*/
Q.prototype.listen = function rqlistener(opts) {
  if (!this._options.createRedis) {
    throw new Error('createRedis function must be passed in as an option for listening to be used.')
  }

  var rq = this,
    sql = this._sql = rq.todo.poppipelisten(rq.doing, _.extend(opts||{}, {redisClone: this._options.createRedis()}));


  sql.on('message', function (taskref, done) {
    async.waterfall([
      function (cb) {
        rq.get(taskref, function (err, obj) {
          cb(err, obj||null)
        })
      },
      function (taskobj, cb) {
        if (!taskobj) {
          return cb(new Error('storage did not return a valid task object for reference: ' + taskref))
        }

        sql.emit('task', taskobj, newdone);

        var called = false;
        function newdone (err) {
          if (called) {
            return;
          }
          called = true;

          if (err) {
            rq.fail(taskobj, err, cb);
          } else {
            rq.finish(taskobj, cb);
          }
        }
      }
    ], function (err) {
      if (err) {
        sql.emit('error', err, taskref);
      }
      done();
    });
  });

  return sql;
};

module.exports = Q;

// -- Finish Helpers --

Q.prototype._finish_clean = function finish_clean(task, dontCheckFailed, callback) {
  if (callback === undefined) callback = dontCheckFailed, dontCheckFailed = false;

  var ref = this.ref(task),
    self = this;

  async.auto({
    setTask: this._keep_storage ? this.set.bind(this, task, ref) : this.del.bind(this, ref),
    sPullPipe: _.bind(this.doing.pull, this.doing, ref),
    checkFailed: ['sPullPipe', function (cb, results) {
      if (results.sPullPipe === 0) {
        if (dontCheckFailed) {
          return cb(null, 0);
        }

        return self.failed.pull(ref, cb);
      }
      cb(null, results.sPullPipe);
    }],
    last: ['checkFailed', function (cb, results) {
      if (results.checkFailed === 0) {
        return callback(new Error('Element ' + (_.isObject(task) ? JSON.stringify(task) : task.toString()) + ' is not currently processing or failed.'));
      }
      callback(null);
    }]
  }, function (err, results) {
    callback(err, results.checkFailed);
  });
};

Q.prototype._finish_dirty = function finish_dirty(task, dontCheckFailed, callback) {
  if (callback === undefined) callback = dontCheckFailed, dontCheckFailed = false;

  var ref = this.ref(task),
    self = this;

  async.auto({
    setTask: _.bind(this.set, this, task, ref),
    sPullPipe: _.bind(this.doing.spullpipe, this.doing, this.done, ref),
    checkFailed: ['sPullPipe', function (cb, results) {
      if (results.sPullPipe === 0) {
        if (dontCheckFailed) {
          return cb(null, 0);
        }

        return self.failed.spullpipe(self.done, ref, cb);
      }
      cb(null, results.sPullPipe);
    }],
    last: ['checkFailed', function (cb, results) {
      if (results.checkFailed === 0) {
        return callback(new Error('Element ' + (_.isObject(task) ? JSON.stringify(task) : task.toString()) + ' is not currently processing or failed.'));
      }
      callback(null);
    }]
  }, function (err, results) {
    callback(err, results.checkFailed);
  });
};
