import { FrameState } from '@/ffmpeg/builder/state/FrameState.js';
import { FrameDataLocation, FrameSize } from '@/ffmpeg/builder/types.js';
import { describe, expect, test } from 'vitest';
import { HlsOutputFormat } from './HlsOutputFormat.ts';

function makeFormat(
  isFirstTranscode: boolean,
  playlistPath = '/some/path/stream.m3u8',
) {
  const state = new FrameState({
    isAnamorphic: false,
    scaledSize: FrameSize.FHD,
    paddedSize: FrameSize.FHD,
    frameDataLocation: FrameDataLocation.Software,
  });
  return new HlsOutputFormat(
    state,
    24,
    playlistPath,
    '/some/path/data%06d.ts',
    '/stream/channels/test-uuid/hls/',
    isFirstTranscode,
    false,
  );
}

describe('HlsOutputFormat', () => {
  test.each([false, true])(
    'uses integer GOP options at 59.94 fps (QSV=%s)',
    (oneSecondGop) => {
      const state = new FrameState({ frameRate: 60000 / 1001 });
      const opts = new HlsOutputFormat(
        state,
        24,
        '/stream.m3u8',
        '/data%06d.ts',
        '/stream/',
        true,
        oneSecondGop,
      ).options();
      expect(opts[opts.indexOf('-g') + 1]).toBe(oneSecondGop ? '60' : '240');
      expect(opts[opts.indexOf('-keyint_min') + 1]).toBe('240');
    },
  );
  test('includes -master_pl_name playlist.m3u8 for first transcode', () => {
    const opts = makeFormat(true).options();
    const idx = opts.indexOf('-master_pl_name');
    expect(idx).toBeGreaterThan(-1);
    expect(opts[idx + 1]).toBe('playlist.m3u8');
  });

  test('includes -master_pl_name playlist.m3u8 for subsequent transcodes', () => {
    const opts = makeFormat(false).options();
    const idx = opts.indexOf('-master_pl_name');
    expect(idx).toBeGreaterThan(-1);
    expect(opts[idx + 1]).toBe('playlist.m3u8');
  });

  test('-master_pl_name appears before the output path', () => {
    const playlistPath = '/some/path/stream.m3u8';
    const opts = makeFormat(true, playlistPath).options();
    const masterIdx = opts.indexOf('-master_pl_name');
    const outputIdx = opts.lastIndexOf(playlistPath);
    expect(masterIdx).toBeGreaterThan(-1);
    expect(outputIdx).toBeGreaterThan(-1);
    expect(masterIdx).toBeLessThan(outputIdx);
  });
});
