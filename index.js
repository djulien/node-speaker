
/**
 * Module dependencies.
 */

var debug = require('debug')('speaker');
var binding = require('bindings')('binding');
var inherits = require('util').inherits;
var Writable = require('stream').Writable;

// node v0.8.x compat
if (!Writable) Writable = require('readable-stream/writable');

/**
 * Module exports.
 */

exports = module.exports = Speaker;

/**
 * Export information about the `mpg123_module_t` being used.
 */

exports.api_version = binding.api_version;
exports.description = binding.description;
exports.module_name = binding.name;

/**
 * The `Speaker` class accepts raw PCM data written to it, and then sends that data
 * to the default output device of the OS.
 *
 * @param {Object} options object
 * @api public
 */

function Speaker (opts) {
  if (!(this instanceof Speaker)) return new Speaker(opts);
  Writable.call(this, opts);

  // set options if provided
  if (opts) this._opts(opts);

  // chunks are sent over to the backend in "samplesPerFrame * blockAlign" size.
  // this is necessary because if we send too big of chunks at once, then there
  // won't be any data ready when the audio callback comes (experienced with the
  // CoreAudio backend)
  this.samplesPerFrame = 1024;

  // flipped after close() is called, no write() calls allowed after
  this._closed = false;

  // call `flush()` upon the "finish" event
  this.on('finish', this._flush);
  this.on('pipe', this._pipe);
}
inherits(Speaker, Writable);

/**
 * Calls the audio backend's `open()` function, and then emits an "open" event.
 */

Speaker.prototype._open = function () {
  debug('open()');
  if (this.audio_handle) {
    throw new Error('_open() called more than once!');
  }
  // set default options, if not set
  if (null == this.channels) {
    debug('setting default "channels"', 2);
    this.channels = 2;
  }
  if (null == this.bitDepth) {
    debug('setting default "bitDepth"', 16);
    this.bitDepth = 16;
  }
  if (null == this.sampleRate) {
    debug('setting default "sampleRate"', 44100);
    this.sampleRate = 44100;
  }
  if (null == this.signed) {
    debug('setting default "signed"', this.bitDepth != 8);
    this.signed = this.bitDepth != 8;
  }

  // calculate the "block align"
  this.blockAlign = this.bitDepth / 8 * this.channels;

  // initialize the audio handle
  // TODO: open async?
  this.audio_handle = new Buffer(binding.sizeof_audio_output_t);
  var r = binding.open(this.audio_handle, this);
  if (0 !== r) {
    throw new Error('open() failed: ' + r);
  }

  this.emit('open');
  return this.audio_handle;
};

/**
 * set given options
 */

Speaker.prototype._opts = function (opts) {
  debug('opts(%j)', opts);
  if (null != opts.channels) {
    debug('setting "channels"', opts.channels);
    this.channels = opts.channels;
  }
  if (null != opts.bitDepth) {
    debug('setting "bitDepth"', opts.bitDepth);
    this.bitDepth = opts.bitDepth;
  }
  if (null != opts.sampleRate) {
    debug('setting "sampleRate"', opts.sampleRate);
    this.sampleRate = opts.sampleRate;
  }
  if (null != opts.float) {
    debug('setting "float"', opts.float);
    this.float = opts.float;
  }
  if (null != opts.signed) {
    debug('setting "signed"', opts.signed);
    this.signed = opts.signed;
  }
  if (null != opts.samplesPerFrame) {
    debug('setting "samplesPerFrame"', opts.samplesPerFrame);
    this.samplesPerFrame = opts.samplesPerFrame;
  }
};

/**
 * `_write()` callback for the Writable base class.
 */

Speaker.prototype._write = function (chunk, done) {
  debug('_write() (%d bytes)', chunk.length);
  if (this._closed) {
    // close() has already been called. this should not be called
    return done(new Error('write() call after close() call'));
  }
  var b;
  var left = chunk;
  var handle = this.audio_handle;
  if (!handle) {
    // this is the first time write() is being called; need to _open()
    handle = this._open();
  }
  var chunkSize = this.blockAlign * this.samplesPerFrame;

  function write () {
    b = left;
    if (b.length > chunkSize) {
      var t = b;
      b = t.slice(0, chunkSize);
      left = t.slice(chunkSize);
    } else {
      left = null;
    }
    debug('writing %d byte chunk', b.length);
    binding.write(handle, b, b.length, afterWrite);
  }
  function afterWrite (r) {
    debug('wrote %d bytes', r);
    if (r != b.length) {
      done(new Error('write() failed: ' + r));
    } else if (left) {
      write();
    } else {
      done();
    }
  }

  write();
};

/**
 * Called when this stream is pipe()d to from another readable stream.
 * If the "sampleRate", "channels", "bitDepth", and "signed" properties are,
 * set, then they will be used over the currently set values.
 */

Speaker.prototype._pipe = function (source) {
  debug('_pipe()');
  this._opts(source);
};

/**
 * Calls the `flush()` bindings for the audio backend.
 */

Speaker.prototype._flush = function () {
  debug('_flush()');

  // TODO: async definitely
  binding.flush(this.audio_handle);

  this.emit('flush');

  // XXX: The audio backends keep ~.5 seconds worth of buffered audio data
  // in their system, so presumably there will be .5 seconds *more* of audio data
  // coming out the speakers, so we must keep the event loop alive so the process
  // doesn't exit. This is a nasty, nasty hack and hopefully there's a better way
  // to be notified when the audio has acutally finished playing.
  setTimeout(this.close.bind(this), 600);
};

/**
 * Closes the audio backend. Normally this function will be called automatically
 * after the audio backend has finished playing the audio buffer through the
 * speakers.
 *
 * @api public
 */

Speaker.prototype.close = function () {
  debug('close()');
  if (this._closed) return;

  if (this.audio_handle) {
    // TODO: async maybe?
    binding.close(this.audio_handle);
    this.audio_handle = null;
  }

  this.emit('close');
  this._closed = true;
};
