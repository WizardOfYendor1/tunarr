import {
  buildConcatPlaylist,
  ConcatPlaylistEntryCount,
} from './ConcatPlaylist.ts';

describe('buildConcatPlaylist', () => {
  test('lists the url once per entry under an ffconcat header', () => {
    const lines = buildConcatPlaylist('http://localhost/stream', 3).split('\n');
    expect(lines).toEqual([
      'ffconcat version 1.0',
      "file 'http://localhost/stream'",
      "file 'http://localhost/stream'",
      "file 'http://localhost/stream'",
    ]);
  });

  test('defaults to enough entries that the concat input never loops', () => {
    const lines = buildConcatPlaylist('http://localhost/stream').split('\n');
    expect(lines).toHaveLength(ConcatPlaylistEntryCount + 1);
  });
});
