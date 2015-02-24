var hyperlog = require('hyperlog')
var thunky = require('thunky')
var mkdirp = require('mkdirp')
var levelup = require('levelup')
var through = require('through2')
var pump = require('pump')
var fs = require('fs')
var path = require('path')
var subleveldown = require('subleveldown')
var lexint = require('lexicographic-integer')
var messages = require('./lib/messages')
var dataset = require('./lib/dataset')

var noop = function () {}

var Dat = function (dir, opts) {
  if (!(this instanceof Dat)) return new Dat(dir, opts)
  if (!opts) opts = {}

  var self = this

  var backend = opts.backend || require('leveldown')
  var datPath = path.join(dir, '.dat')
  var levelPath = path.join(datPath, 'db')

  this.path = datPath
  this.log = null

  this._db = null
  this._meta = null
  this._view = null
  this._data = null
  this._branches = null
  this._index = {}

  this._callbacks = {}
  this._change = 0

  this.open = thunky(function (cb) {
    fs.exists(datPath, function (exists) {
      if (!exists && !opts.createIfMissing) return cb(new Error('No dat here'))

      mkdirp(datPath, function (err) {
        if (err) return cb(err)

        self._db = levelup(path.join(datPath, 'db'), {db: backend})
        self._view = subleveldown(self._db, 'view', {valueEncoding: 'binary'})
        self._meta = subleveldown(self._view, 'meta', {valueEncoding: 'utf-8'})
        self._data = subleveldown(self._view, 'data', {valueEncoding: 'utf-8'})
        self._branches = subleveldown(self._view, 'branches', {valueEncoding: 'utf-8'})

        self.log = hyperlog(subleveldown(self._db, 'hyperlog'))

        var write = function (data, enc, cb) {
          self.log.get(data.key, function (err, root) {
            if (err) return cb(err)
            self.log.get(data.value, function (err, head) {
              if (err) return cb(err)
              var name = messages.Commit.decode(root.value).dataset
              if (!self._index[name]) self._index[name] = {}
              self._index[name][head.hash] = {head: head, root: root}
              cb()
            })
          })
        }

        pump(self._branches.createReadStream(), through.obj(write), function (err) {
          if (err) return cb(err)
          self._process()
          cb(null, self)
        })
      })
    })
  })
}

Dat.prototype._process = function () {
  var self = this
  var index = this._index

  var key = function (sub, key) { // a bit leaky :(
    return '!' + sub + '!' + key
  }

  var process = function (node, enc, cb) {
    var value = messages.Commit.decode(node.value)
    var batch = []
      
    var set = value.dataset

    if (!set) return cb()
    if (!index[set]) index[set] = {}
    var sindex = index[set]

    if (node.links.length > 1) throw new Error('merges not implemented yet!')

    var prev = node.links.length && node.links[0]

    if (!prev || !sindex[prev.hash]) {
      sindex[node.hash] = {root: node, head: node}
    } else {
      sindex[prev.hash].head = node
      sindex[node.hash] = sindex[prev.hash]      
      delete sindex[prev.hash]
    }

    var rhash = sindex[node.hash].root.hash

    batch.push({type: 'put', key: key('branches', rhash), value: node.hash})

    if (value.type === 'put') {
      batch.push({type: 'put', key: '!data!!' + rhash + '!0!' +  value.key, value: node.hash})
      batch.push({type: 'put', key: '!data!!' + rhash + '!1!' +  value.key + '!' + lexint.pack(node.change, 'hex'), value: node.hash})
    }

    if (value.type === 'del') {
      batch.push({type: 'del', key: '!data!!' + rhash + '!0!' +  value.key})
      batch.push({type: 'put', key: '!data!!' + rhash + '!1!' +  value.key + '!' + lexint.pack(node.change, 'hex'), value: ' '})      
    }

    batch.push({type: 'put', key: '!meta!change', value: '' + node.change})
    self._view.batch(batch, function (err) {
      if (err) return cb(err)

      var queued = self._callbacks[node.change]
      delete self._callbacks[node.change]
      if (queued) queued(null)

      cb()
    })
  }

  self._meta.get('change', function (err, change) {
    if (err && !err.notFound) throw err

    change = parseInt(change || 0)
    self.log.createChangesStream({since: change, live: true}).pipe(through.obj(process))    
  })
}

Dat.prototype._flush = function (node, cb) {
  if (this._change >= node.change) return cb()
  this._callbacks[node.change] = cb
}

Dat.prototype.dataset = function (name, branch) {
  return dataset(this, name, branch)
}

module.exports = Dat
