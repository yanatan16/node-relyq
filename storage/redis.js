// storage/msgpack_redis.js
// A task storage backend to store task object as msgpack in Redis

// builtin
var util = require('util');

// vendor
var msgpack = require('msgpack');

// local
var Q = require('../relyq');

// Storage services must provide two functions
// {
//   get: function (taskid, callback) {
//     callback(err, taskobj);
//   },
//   set: function (taskobj, callback) {
//     callback(err, taskid);
//   }
// }
// taskobj - Application level task objects
// taskid - A task identifier that can be used to store and later retrieve the taskobj

// -- Main Type --
// Redis Storage Backend
function RedisStorage(redis, preopts) {
  this._redis = redis;
  this._prefix = preopts.storage_prefix || ((preopts.prefix || preopts) + this._delimeter + 'jobs');
  this._delimeter = preopts.delimeter || ':';

  Q.call(this, redis, preopts);
}

util.inherits(RedisStorage, Q);

// Override these to add a new serialization

// @overridable
RedisStorage.prototype.serialize = function (obj) {
  return 'string';
};

// @overridable
RedisStorage.prototype.deserialize = function (str) {
  return {str:str};
};


RedisStorage.prototype._key = function (taskid) {
  return this._prefix + this._delimeter + taskid;
};

RedisStorage.prototype.get = function (taskid, callback) {
  var self = this;
  this._redis.get(this._key(taskid), function (err, result) {
    if (err) {
      return callback(err);
    }

    try {
      callback(null, self.deserialize(result));
    } catch (e) {
      callback(e);
    }
  });
};

RedisStorage.prototype.set = function (taskobj, taskid, callback) {
  try {
    this._redis.set(this._key(taskid), this.serialize(taskobj), function (err, ok) {
      callback(err, taskid);
    });
  } catch (e) {
    callback(e);
  }
};

RedisStorage.prototype.del = function (taskid, callback) {
  this._redis.del(this._key(taskid), callback);
};

// -- Redis Json Storage --

function RedisJsonStorage(redis, preopts) {
  if (!(this instanceof RedisJsonStorage)) {
    return new RedisJsonStorage(redis, preopts);
  }

  RedisStorage.call(this, redis, preopts);
}
util.inherits(RedisJsonStorage, RedisStorage);

RedisJsonStorage.prototype.serialize = JSON.stringify;
RedisJsonStorage.prototype.deserialize = JSON.parse;

// -- Redis MsgPack Storage --

function RedisMsgPackStorage(redis, preopts) {
  if (!(this instanceof RedisMsgPackStorage)) {
    return new RedisMsgPackStorage(redis, preopts);
  }

  RedisStorage.call(this, redis, preopts);
}
util.inherits(RedisMsgPackStorage, RedisStorage);

RedisMsgPackStorage.prototype.serialize = function (obj) {
  return msgpack.pack(obj).toString('binary');
};
RedisMsgPackStorage.prototype.deserialize = function (str) {
  return msgpack.unpack(new Buffer(str, 'binary'));
};

module.exports = {
  msgpack: RedisMsgPackStorage,
  json: RedisJsonStorage
};