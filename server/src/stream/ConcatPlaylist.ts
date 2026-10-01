/**
 * Number of entries in the ffconcat playlist that feeds an mpegts concat
 * session. Each entry plays one program, so this caps how many programs a
 * single concat ffmpeg process carries before it exits and the session is
 * recreated.
 *
 * The playlist must never be looped with `-stream_loop`. ffmpeg's concat
 * demuxer reuses each entry's duration from the previous pass when it
 * reopens that entry (concatdec.c only tracks `next_dts` while the entry's
 * duration is unknown). Every entry here is the same live URL that returns
 * a different program each time, so on the second pass the second entry is
 * placed at the length of the first pass's first program instead of the
 * program that just played. Output timestamps then jump backwards and the
 * muxer crawls them forward one tick per packet, which corrupts video and
 * drops audio until the timestamps catch up.
 *
 * A long, unlooped playlist gives every program its own entry, so the
 * demuxer measures each one fresh.
 */
export const ConcatPlaylistEntryCount = 1000;

/**
 * Builds an ffconcat playlist that lists `url` `entryCount` times.
 */
export function buildConcatPlaylist(
  url: string,
  entryCount: number = ConcatPlaylistEntryCount,
): string {
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < entryCount; i++) {
    lines.push(`file '${url}'`);
  }
  return lines.join('\n');
}
