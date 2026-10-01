import { buildConcatPlaylist } from '@/stream/ConcatPlaylist.js';
import { HttpStreamSource } from '@/stream/types.js';
import { first, last } from 'lodash-es';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createTempWorkdir } from '../../../testing/ffmpeg/FfmpegIntegrationHelper.ts';
import {
  binaries,
  ffmpegTest,
} from '../../../testing/ffmpeg/FfmpegTestFixtures.ts';
import { ConcatInputSource } from '../input/ConcatInputSource.ts';
import { FfmpegState } from '../state/FfmpegState.ts';
import { FrameSize } from '../types.ts';
import { SoftwarePipelineBuilder } from './software/SoftwarePipelineBuilder.ts';

// Program lengths in seconds, one per /stream request. The first program is
// shorter than the third, like a session that tunes in mid-program. Before
// the concat input stopped looping, the fourth program started
// (third - first) seconds behind the end of the third.
const ProgramSeconds = [2, 4, 4, 4, 4, 4];
const FrameRate = 25;

type Packet = { streamIndex: number; codecType: string; dts: number };

function generateProgram(ffmpeg: string, seconds: number, outputPath: string) {
  // Mirrors a per-program transcode: fresh MPEG-TS whose timestamps start at
  // zero, with -muxdelay 0 -muxpreload 0.
  const result = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=320x240:rate=${FrameRate}`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      `${seconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      `${FrameRate}`,
      '-c:a',
      'aac',
      '-muxdelay',
      '0',
      '-muxpreload',
      '0',
      '-f',
      'mpegts',
      '-y',
      outputPath,
    ],
    { stdio: 'ignore' },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to generate ${seconds}s program`);
  }
}

function probePackets(ffprobe: string, filePath: string): Packet[] {
  const result = spawnSync(
    ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'packet=stream_index,dts_time:stream=index,codec_type',
      '-of',
      'json',
      filePath,
    ],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(result.stdout) as {
    packets: { stream_index: number; dts_time?: string }[];
    streams: { index: number; codec_type: string }[];
  };
  const codecTypes = new Map(
    parsed.streams.map((stream) => [stream.index, stream.codec_type]),
  );
  return parsed.packets.flatMap((packet) =>
    packet.dts_time === undefined
      ? []
      : [
          {
            streamIndex: packet.stream_index,
            codecType: codecTypes.get(packet.stream_index) ?? 'unknown',
            dts: parseFloat(packet.dts_time),
          },
        ],
  );
}

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe.skipIf(!binaries)('mpegts concat pipeline integration', () => {
  let workdir: string;
  let cleanup: () => Promise<void>;
  let server: http.Server | undefined;

  beforeAll(async () => {
    ({ dir: workdir, cleanup } = await createTempWorkdir());
  });

  afterAll(async () => {
    server?.close();
    await cleanup();
  });

  ffmpegTest(
    'keeps timestamps continuous across program boundaries',
    { timeout: 120_000 },
    async ({ binaryCapabilities, ffmpegVersion }) => {
      if (!binaries) {
        throw new Error('ffmpeg binaries are required');
      }
      const { ffmpeg, ffprobe } = binaries;
      for (const seconds of new Set(ProgramSeconds)) {
        generateProgram(
          ffmpeg,
          seconds,
          path.join(workdir, `program_${seconds}.ts`),
        );
      }

      // Stands in for Tunarr's /ffmpeg/playlist and /stream endpoints. Every
      // playlist entry is the same URL, and each request returns the next
      // program as a chunked body of unknown length, like a live transcode.
      let requestCount = 0;
      let onLineupExhausted = () => {};
      let port = 0;
      const programServer = http.createServer((req, res) => {
        if (req.url?.startsWith('/playlist')) {
          res.end(buildConcatPlaylist(`http://127.0.0.1:${port}/stream`));
          return;
        }

        const seconds = ProgramSeconds[requestCount++];
        if (seconds === undefined) {
          res.statusCode = 404;
          res.end();
          onLineupExhausted();
          return;
        }

        res.setHeader('Content-Type', 'video/mp2t');
        void fs
          .readFile(path.join(workdir, `program_${seconds}.ts`))
          .then((data) => res.end(data));
      });
      server = programServer;
      await new Promise<void>((resolve) =>
        programServer.listen(0, '127.0.0.1', resolve),
      );
      port = (programServer.address() as AddressInfo).port;

      const concatInput = new ConcatInputSource(
        new HttpStreamSource(`http://127.0.0.1:${port}/playlist`),
        FrameSize.withDimensions(320, 240),
      );
      const pipeline = new SoftwarePipelineBuilder(
        null,
        null,
        null,
        null,
        concatInput,
        binaryCapabilities,
      ).concat(concatInput, FfmpegState.forConcat(ffmpegVersion, 'Test'));
      const args = pipeline.getCommandArgs();

      const outputPath = path.join(workdir, 'concat.ts');
      const output = createWriteStream(outputPath);
      const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      proc.stdout.pipe(output);
      // A real session keeps reading programs; stop once the lineup is used up.
      onLineupExhausted = () => proc.kill('SIGINT');
      await new Promise<void>((resolve) => proc.on('close', () => resolve()));
      await new Promise<void>((resolve) => output.close(() => resolve()));

      const packets = probePackets(ffprobe, outputPath);
      const totalSeconds = ProgramSeconds.reduce((sum, s) => sum + s, 0);

      for (const codecType of ['video', 'audio']) {
        const dts = packets
          .filter((packet) => packet.codecType === codecType)
          .map((packet) => packet.dts);
        expect(dts.length, `${codecType} packets`).toBeGreaterThan(0);

        const steps: { from: number; to: number }[] = [];
        for (let i = 1; i < dts.length; i++) {
          const from = dts[i - 1];
          const to = dts[i];
          if (from !== undefined && to !== undefined) {
            steps.push({ from, to });
          }
        }
        const typical = median(steps.map(({ from, to }) => to - from));
        // A backwards jump shows up as the muxer's +1 tick crawl, so flag any
        // step well under the typical packet spacing. Programs end on whole
        // packets, so a boundary may leave a gap, but never a whole frame.
        const irregular = steps
          .filter(
            ({ from, to }) =>
              to - from < typical * 0.5 || to - from > typical + 1 / FrameRate,
          )
          .map(({ from, to }) => `${from.toFixed(4)} -> ${to.toFixed(4)}`);
        expect(irregular, `${codecType} timestamp discontinuities`).toEqual([]);

        // Every program made it into the output, at its full length.
        const span = (last(dts) ?? 0) - (first(dts) ?? 0);
        expect(span, `${codecType} span`).toBeGreaterThan(totalSeconds - 0.5);
      }

      expect(
        requestCount,
        `ffmpeg stopped early: ${args.join(' ')}\n${stderr}`,
      ).toBeGreaterThan(ProgramSeconds.length);
    },
  );
});
