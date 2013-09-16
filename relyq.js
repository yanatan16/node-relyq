// relyq
// A reliable task queue

// vendor
var async = require('async'),
  _ = require('underscore'),
  redisPkg = require('redis'),
  simpleq = require('simpleq');

// -- Master Type: Q --
// The master type, a task queue
function Q(redis, preopts) {
  // handle forgetting a 'new'
  if (!(this instanceof Q)) {
    return new Q(redis, preopts);
  }

  var Constructor = this.constructor;
  this.clone = this.clone || function () {
    return new Constructor(redisPkg.createClient(redis.port, redis.host, redis.options), preopts);
  };

  this._delimeter = preopts.delimeter || ':';

  var idfield = this._idfield = preopts.idfield || 'id';
  this._getid = preopts.getid || function (task) {
    return task[idfield];
  };

  this._prefix = preopts.prefix || preopts;

  this.todo = new simpleq.Q(redis, this._prefix + ':todo');
  this.doing = new simpleq.Q(redis, this._prefix + ':doing');
  this.failed = new simpleq.Q(redis, this._prefix + ':failed');
  this.done = new simpleq.Q(redis, this._prefix + ':done');
}

// @overridable
// Get a task object from its reference id
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
Q.prototype.del = function del(taskobj, taskref, callback) {
  callback();
};

// Override these to add a new serialization
// refs get put into the queue
// @overridable
Q.prototype.ref = function (obj) {
  return obj;
};

// -- Superclass methods ---

Q.prototype.push = function push(task, callback) {
  var ref = this.ref(task);
  async.parallel([
    _.bind(this.set, this, task, ref),
    _.bind(this.todo.push, this.todo, ref)
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

Q.prototype.finish = function finish(task, dontCheckFailed, callback) {
  if (callback === undefined) callback = dontCheckFailed, dontCheckFailed = false;

  var ref = this.ref(task),
    self = this;
  async.parallel([
    _.bind(this.set, this, task, ref),
    _.bind(this.doing.spullpipe, this.doing, this.done, ref),
  ], function (err, results) {
    if (err) {
      return callback(err);
    }

    if (results && results[1] === 0) {
      if (dontCheckFailed) {
        return callback(null, new Error('Element ' + task + ' is not currently processing.'));
      }


      return self.failed.spullpipe(self.done, ref, function (err, result) {
        callback(err || (result===0 && new Error('Element ' + task + ' is not currently processing or failed.')) || undefined, result);
      });
    }

    callback(null, results[1]);
  });
};

Q.prototype.fail = function fail(task, callback) {
  var ref = this.ref(task);
  async.parallel([
    _.bind(this.set, this, task, ref),
    _.bind(this.doing.spullpipe, this.doing, this.failed, ref)
  ], function (err, results) {
    if (err) {
      return callback(err);
    }
    if (results && results[1] === 0) {
      return callback(new Error('Element ' + task + ' is not currently processing.'));
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
    _.bind(this.del, this, task, ref),
    _.bind(this[from].pull, this[from], ref)
  ], function (err, results) {
    callback(err, results && results.length === 2 && results[1]);
  });
};

module.exports = Q;