/*
 * SourceLook is local-only. fs-service still imports a remote filesystem
 * implementation; this stub keeps that import resolvable and makes every remote
 * path report "not remote", so the local code paths are the only ones taken.
 */
'use strict';

const path = require('path');

function isRemote() {
  return false;
}

function sameRoot(a, b) {
  return a === b;
}

function canonical(root) {
  return String(root || '');
}

function parse() {
  return null;
}

function join(base, sub) {
  return path.posix.join(String(base || ''), String(sub || ''));
}

function rel(root, abs) {
  return path.posix.relative(canonical(root), String(abs || ''));
}

function resolve(root, sub) {
  return path.posix.resolve(canonical(root), String(sub || ''));
}

function basename(value) {
  return path.posix.basename(String(value || ''));
}

class RemoteFs {
  constructor() {
    throw new Error('SourceLook does not support remote projects.');
  }
}

module.exports = {
  isRemote,
  sameRoot,
  canonical,
  parse,
  join,
  rel,
  resolve,
  basename,
  RemoteFs,
};
