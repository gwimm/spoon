#!/usr/bin/env node

const Url         = require('url').URL;
const exec        = require('child_process').exec;
const querystring = require('querystring');
const path        = require('path');
const fs          = require('fs');
const http        = require('http');
const https       = require('https');
const util        = require('util')

const delay       = util.promisify(setTimeout);
const writeFile   = util.promisify(fs.writeFile);
const mkdir       = util.promisify(fs.mkdir);

const groupBy = (arr, f) => arr.reduce((acc, cur) => {
  const val = f(cur);
  acc[val] = (acc[val] || []).concat(cur);
  return acc;
}, {});

const request = async (url, opts = {}) => {
  if (opts.timeout) await delay(opts.timeout);
  return new Promise((resolve, reject) => {
    url = new Url(url);
    const lib = { 'http:': http, 'https:': https }[url.protocol];
    if (!lib) reject();
    lib.get(url, r => {
      let body = '';
      let p;
      const consumeBody = () => {
        if (p) return p;
        p = new Promise((resolve, reject) => {
          r.on('data' , chunk => body += chunk);
          r.on('error', reject);
          r.on('end'  , () => resolve());
        });
        return p;
      };
      resolve({
        async text() { await consumeBody(); return body; },
        async json() { await consumeBody(); return JSON.parse(body); },
        async download(dst) {
          return new Promise((resolve, reject) => {
            dst = fs.createWriteStream(dst);
            r.pipe(dst);
            dst.on('finish', () => dst.close(resolve));
          });
        },
        pipe: (...args) => r.pipe(...args),
        response: () => r,
      });
    });
  });
};

const extractors = {}

extractors.youtube = url => {
  const video = async id => {
    let src = new Url("https://www.youtube.com/watch");
    src.searchParams.append('v', id);
    let data = groupBy(JSON.parse(
      await request(src).then(r => r.text())
        .match(/ytplayer\.config = (.*);ytplayer\.load = function/)[1]
      ).args.adaptive_fmts.split(',')
        .map(o => querystring.parse(o)), o => o.type.split('/')[0]
    );
    for (var k in data)
      data[k].sort((a, b) => parseInt(b.clen) - parseInt(a.clen));
    return {
      data: data,
      download (path) {
      },
    };
  };
  const dsturl = new Url(url);
  const [, type, id] = dsturl.pathname.split('/');
  switch (type) {
    case 'watch':   return video(dsturl.searchParams.get('v')); break;
    case 'channel': return channel(id);                         break;
  }
};

extractors.mangadex = url => {
  const chapter = async id => { return {
    data: await request(
        'https://mangadex.org/api/chapter/' + id
        { timeout: 1000 }
      ).then(r => r.json()),
    async download (dst = "") {
      dst = path.join(dst,
        (dir =>
          dir.length >= (255 - 3)
            ? dir.slice(0, 255 - 3).padEnd(3, '.')
            : dir
        )('vol-' + this.data.volume  + '_' +
          'ch-'  + this.data.chapter + '_' +
          '-_'   + (this.title
            ? this.title
              .toLowerCase().replace(/[^A-Za-z0-9-_.]/g, '_').trim('_')
            : "")
        )
      );
      try { await mkdir(dst, 0o755); } catch (e) { return }
      writeFile(path.join(dst, 'meta.json'), JSON.stringify(this.data));
      this.data.page_array.forEach(async (img, i) => {
        await request(
          path.join(this.data.server, this.data.hash, img),
          { timeout: 1000 }
        ).then(r => r.download(path.join(dst, i + path.extname(img))))
      });
    },
  };};
  const manga = async id => { return {
    data: await request(
        'https://mangadex.org/api/manga/' + id,
        { timeout: 1000 }
      ).then(r => r.json()),
    async download (dir = "") {
      dir = path.join(dir, this.data.manga.title
        .toLowerCase().replace(/[^A-Za-z0-9-_.]/g, '_').trim('_')
      );
      try { await mkdir(dir, 0o755); } catch (e) { return }
      Object.keys(this.data.chapter).forEach(async chap => {
        if (this.data.chapter[chap].lang_code == 'gb') {
          await chapter(chap).then(data => data.download(dir));
        }
      });
    },
  };};
  const [, type, id] = (new Url(url)).pathname.split('/');
  switch (type) {
    case 'title':   return manga(id);   break;
    case 'chapter': return chapter(id); break;
  }
};

(async (extractor, url) => {
  await extractors[extractor](url).then(data => data.download("./"));
})(process.argv[2], process.argv[3])
