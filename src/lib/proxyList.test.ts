import {describe, expect, it} from 'vitest';
import {parseProxyList} from './proxyList';
import {proxyImportExampleCsv, proxyImportExampleList} from '../data/importTemplate';
import type {ScoutProxy} from '../types';

const none: ScoutProxy[] = [];
const proxies = (content: string, existing: ScoutProxy[] = none) =>
  parseProxyList(content, existing).map((entry) => entry.proxy);

describe('parseProxyList — the line path', () => {
  it('reads the colon shorthand every vendor hands out', () => {
    expect(proxies('198.51.100.10:1080:user:pass')).toEqual([{
      type: 'socks5',
      host: '198.51.100.10',
      port: 1080,
      username: 'user',
      password: 'pass',
      name: '198.51.100.10:1080',
    }]);
  });

  it('drops blank lines and # comments', () => {
    const parsed = parseProxyList('# my proxies\n\n198.51.100.10:1080\n', none);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].line).toBe(3);
  });

  it('keeps an unreadable line so the review table can show it', () => {
    const [entry] = parseProxyList('nonsense', none);
    expect(entry.proxy).toBeNull();
    expect(entry.error).toContain('Not a proxy');
  });

  // The bug this file exists for: the same list, saved with commas instead of
  // colons, used to come back with every line marked unreadable.
  it('reads a headerless comma-delimited list', () => {
    expect(proxies('198.51.100.10,1080,user,pass')).toEqual([{
      type: 'socks5',
      host: '198.51.100.10',
      port: 1080,
      username: 'user',
      password: 'pass',
      name: '198.51.100.10:1080',
    }]);
  });

  it('reads semicolons, tabs and pipes the same way', () => {
    for (const separator of [';', '\t', '|']) {
      expect(proxies(['198.51.100.10', '1080', 'user', 'pass'].join(separator))[0])
          .toMatchObject({host: '198.51.100.10', port: 1080, username: 'user', password: 'pass'});
    }
  });

  it('reads a type column in front of a delimited line', () => {
    const [entry] = parseProxyList('http,198.51.100.10,1080,user,pass', none);
    expect(entry.proxy).toMatchObject({type: 'http', host: '198.51.100.10', port: 1080});
    // The file named the protocol, so the dialog's one-type selector must not
    // reassign this row.
    expect(entry.explicitType).toBe(true);
  });

  it('reports no explicit type for a bare delimited line', () => {
    expect(parseProxyList('198.51.100.10,1080', none)[0].explicitType).toBe(false);
  });

  // Duplicates against the library and against the file's own earlier lines, so
  // the count the dialog shows is the number of proxies that will actually land.
  it('marks a repeat inside the file as a duplicate', () => {
    const parsed = parseProxyList('198.51.100.10,1080\n198.51.100.10,1080', none);
    expect(parsed.map((entry) => entry.duplicate)).toEqual([false, true]);
  });

  it('marks a proxy already in the library as a duplicate', () => {
    const existing = [{
      id: '1', name: 'x', type: 'socks5', host: '198.51.100.10', port: 1080, username: '',
    } as ScoutProxy];
    expect(parseProxyList('198.51.100.10,1080', existing)[0].duplicate).toBe(true);
  });
});

describe('parseProxyList — the column path', () => {
  it('reads a headed CSV', () => {
    expect(proxies('host,port,username,password\n198.51.100.10,1080,user,pass')).toEqual([{
      type: 'socks5',
      host: '198.51.100.10',
      port: 1080,
      username: 'user',
      password: 'pass',
      name: '198.51.100.10:1080',
    }]);
  });

  it('accepts the aliases real exports use', () => {
    expect(proxies('IP,Port,Login,Pass\n198.51.100.10,1080,user,pass')[0])
        .toMatchObject({host: '198.51.100.10', port: 1080, username: 'user', password: 'pass'});
  });

  it('reads columns in an unusual order', () => {
    expect(proxies('password,port,host,username\npass,1080,198.51.100.10,user')[0])
        .toMatchObject({host: '198.51.100.10', port: 1080, username: 'user', password: 'pass'});
  });

  it('takes the protocol from a type column', () => {
    const [entry] = parseProxyList('host,port,protocol\n198.51.100.10,1080,http', none);
    expect(entry.proxy).toMatchObject({type: 'http'});
    expect(entry.explicitType).toBe(true);
  });

  it('reads a semicolon-delimited spreadsheet export', () => {
    expect(proxies('host;port;username;password\n198.51.100.10;1080;user;pass')[0])
        .toMatchObject({host: '198.51.100.10', port: 1080, username: 'user', password: 'pass'});
  });

  // Excel writes a BOM, and parseCsv strips it -- without that the first header
  // key reads back as something no alias matches and the whole file is a header
  // that is not one.
  it('survives a UTF-8 BOM on the header', () => {
    expect(proxies('﻿host,port\n198.51.100.10,1080')[0])
        .toMatchObject({host: '198.51.100.10', port: 1080});
  });

  it('keeps a quoted password containing a comma intact', () => {
    expect(proxies('host,port,username,password\n198.51.100.10,1080,user,"a,b"')[0])
        .toMatchObject({password: 'a,b'});
  });

  it('names the proxy from a name column when the file has one', () => {
    expect(proxies('name,host,port\nBerlin 1,198.51.100.10,1080')[0])
        .toMatchObject({name: 'Berlin 1'});
  });

  // A column that holds the whole endpoint rather than a bare host. More than
  // one provider heads that column "proxy", and naming your columns is not a
  // promise that each one holds a single value.
  it('splits an endpoint out of the host column', () => {
    expect(proxies('proxy,username,password\n198.51.100.10:1080,user,pass')[0])
        .toMatchObject({host: '198.51.100.10', port: 1080, username: 'user', password: 'pass'});
  });

  it('lets an explicit port column win over one inside the host cell', () => {
    expect(proxies('host,port\n198.51.100.10:1080,9999')[0]).toMatchObject({port: 9999});
  });

  it('reports a row with no host rather than dropping it', () => {
    const [entry] = parseProxyList('host,port\n,1080', none);
    expect(entry.proxy).toBeNull();
    expect(entry.error).toBe('No host in this row');
  });

  it('numbers rows by their line in the file, comments included', () => {
    const parsed = parseProxyList('# exported 2026-08-09\nhost,port\n198.51.100.10,1080', none);
    expect(parsed[0].line).toBe(3);
  });

  // Both halves of the header test. One known column name is a coincidence, and
  // a line that parses as a proxy is data whatever its first cell is called --
  // a host of "port.example.com" must not cost the file its first row.
  it('does not treat a data line as a header', () => {
    expect(parseProxyList('port.example.com,1080\nother.example.com,1080', none))
        .toHaveLength(2);
  });

  it('needs two known columns before it believes in a header', () => {
    const parsed = parseProxyList('host\n198.51.100.10:1080', none);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].proxy).toBeNull();
  });
});

// "Here is the format" is only verifiable rather than a claim if the file the
// Download example button writes imports cleanly through this parser.
describe('the downloadable examples', () => {
  it('reads every line of the example list', () => {
    const parsed = parseProxyList(proxyImportExampleList(), none);
    expect(parsed.filter((entry) => !entry.proxy)).toEqual([]);
    expect(parsed.length).toBeGreaterThan(8);
  });

  it('reads every row of the example CSV', () => {
    const parsed = parseProxyList(proxyImportExampleCsv(), none);
    expect(parsed.filter((entry) => !entry.proxy)).toEqual([]);
    expect(parsed.map((entry) => entry.proxy?.name)).toContain('Shop EU');
    expect(parsed.find((entry) => entry.proxy?.name === 'Rotating')?.proxy?.password)
        .toBe('pa55,word');
  });
});
