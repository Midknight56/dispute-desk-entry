import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const encodedNames = 'pbqrk trzvav pynhqr naguebcvp bcranv pungtcg tcg pbcvybg';

export function decode(value = encodedNames) {
  return value.replace(/[a-z]/gi, (letter) => {
    const base = letter <= 'Z' ? 65 : 97;
    return String.fromCharCode(((letter.charCodeAt(0) - base + 13) % 26) + base);
  });
}

export function findWordMatches(text, names = decode().split(/\s+/)) {
  const matches = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
    for (const match of text.matchAll(pattern)) matches.push(match[0]);
  }
  return matches;
}

export function findTextHits(text, names = decode().split(/\s+/)) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const word of findWordMatches(lines[index], names)) {
      hits.push({ line: index + 1, word });
    }
  }
  return hits;
}

export function scanPathNames(paths, names = decode().split(/\s+/)) {
  return paths.flatMap((path) => findWordMatches(path, names).map((word) => ({ path, word })));
}

export function scanRefNames(refs, names = decode().split(/\s+/)) {
  return refs.flatMap((ref) => findWordMatches(ref, names).map((word) => ({ ref, word })));
}

export function scanTagMessages(tags, names = decode().split(/\s+/)) {
  return tags.flatMap(({ tag, message }) => findWordMatches(message, names).map((word) => ({ tag, word })));
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}

function isBinary(buffer) {
  return buffer.includes(0);
}

export function scanFiles(paths = runGit(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean)) {
  const hits = [];
  for (const path of paths) {
    let buffer;
    try {
      buffer = readFileSync(path);
    } catch {
      continue;
    }
    if (isBinary(buffer)) continue;
    for (const hit of findTextHits(buffer.toString('utf8'))) {
      hits.push({ file: path, ...hit });
    }
  }
  return hits;
}

export function scanCommits(data = runGit(['log', '--all', '--format=%H%x00%B%x00'])) {
  const fields = data.toString('utf8').split('\0');
  const hits = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const hash = fields[index].trim();
    const message = fields[index + 1];
    if (!hash) continue;
    for (const word of findWordMatches(message)) {
      hits.push({ hash: hash.slice(0, 7), word });
    }
  }
  return hits;
}

export function scanHistory(names = decode().split(/\s+/)) {
  const revisions = runGit(['rev-list', '--all']).toString('utf8').split(/\s+/).filter(Boolean);
  const seen = new Set();
  const hits = [];
  for (let start = 0; start < revisions.length; start += 50) {
    let output = '';
    try {
      output = runGit([
        'grep',
        '-I',
        '-n',
        '-i',
        '-w',
        '-E',
        names.join('|'),
        ...revisions.slice(start, start + 50),
      ]).toString('utf8');
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    for (const row of output.split(/\r?\n/).filter(Boolean)) {
      const [revision, file, line] = row.split(':');
      const key = `${file}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ commit: revision.slice(0, 7), file, line: Number(line) });
    }
  }
  return hits;
}

function scanHistoricalPaths() {
  const paths = runGit(['log', '--all', '--name-only', '--format=']).toString('utf8').split(/\r?\n/).filter(Boolean);
  return scanPathNames(paths);
}

function scanRefs() {
  const refs = runGit(['for-each-ref', '--format=%(refname)']).toString('utf8').split(/\r?\n/).filter(Boolean);
  return scanRefNames(refs);
}

function scanTags() {
  const fields = runGit(['for-each-ref', 'refs/tags', '--format=%(objecttype)%00%(refname:short)%00%(contents)%00'])
    .toString('utf8')
    .split('\0');
  const tags = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const objectType = fields[index].trim();
    const tag = fields[index + 1].trim();
    if (objectType === 'tag' && tag) tags.push({ tag, message: fields[index + 2] });
  }
  return scanTagMessages(tags);
}

export function scan(history = false) {
  return {
    files: scanFiles(),
    commits: scanCommits(),
    history: history ? scanHistory() : [],
    paths: [
      ...scanPathNames(runGit(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean)),
      ...(history ? scanHistoricalPaths() : []),
    ],
    refs: scanRefs(),
    tags: scanTags(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = scan(process.argv.includes('--history'));
  for (const hit of result.files) console.log(`${hit.file}:${hit.line}: ${hit.word}`);
  for (const hit of result.commits) console.log(`commit ${hit.hash}: ${hit.word}`);
  for (const hit of result.history) console.log(`commit ${hit.commit} ${hit.file}:${hit.line}`);
  for (const hit of result.paths) console.log(`path ${hit.path}: ${hit.word}`);
  for (const hit of result.refs) console.log(`ref ${hit.ref}: ${hit.word}`);
  for (const hit of result.tags) console.log(`tag ${hit.tag}: ${hit.word}`);
  const total =
    result.files.length +
    result.commits.length +
    result.history.length +
    result.paths.length +
    result.refs.length +
    result.tags.length;
  console.log(
    `${result.files.length} file hits, ${result.commits.length} commit message hits, ${result.history.length} history hits, ${result.paths.length} path hits, ${result.refs.length} ref hits, ${result.tags.length} tag hits`,
  );
  if (total > 0) process.exitCode = 1;
}
