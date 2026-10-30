/** Small, demuxable silence fixtures; no provider credentials or copyrighted audio. */
export function mp3Fixture(sampleRate: 24000 | 48000 = 24000): Buffer {
  const frameSize = sampleRate === 24000 ? 192 : 192;
  return Buffer.concat(
    Array.from({ length: 10 }, () => {
      const frame = Buffer.alloc(frameSize);
      // MPEG-2/64 kbps/24 kHz or MPEG-1/64 kbps/48 kHz, mono.
      frame.set(
        sampleRate === 24000
          ? [0xff, 0xf3, 0x84, 0xc0]
          : [0xff, 0xfb, 0x54, 0xc0],
      );
      return frame;
    }),
  );
}
export function wavFixture(seconds = 1, sampleRate = 48000): Buffer {
  const size = Math.round(seconds * sampleRate) * 2,
    bytes = Buffer.alloc(44 + size);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + size, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(size, 40);
  return bytes;
}

export async function opusFixture(): Promise<Buffer> {
  const {
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacket,
    OggOutputFormat,
    Output,
  } = await import("mediabunny");
  const output = new Output({
    target: new BufferTarget(),
    format: new OggOutputFormat(),
  });
  const source = new EncodedAudioPacketSource("opus");
  output.addAudioTrack(source);
  await output.start();
  const description = Buffer.alloc(19);
  description.write("OpusHead");
  description[8] = 1;
  description[9] = 1;
  description.writeUInt32LE(48000, 12);
  await source.add(
    new EncodedPacket(new Uint8Array([0xf8, 0xff, 0xfe]), "key", 0, 0.02),
    {
      decoderConfig: {
        codec: "opus",
        numberOfChannels: 1,
        sampleRate: 48000,
        description,
      },
    },
  );
  await output.finalize();
  return Buffer.from(output.target.buffer!);
}
