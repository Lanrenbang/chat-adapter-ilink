let silkModule: typeof import("silk-wasm") | null = null;

async function getSilkModule(): Promise<typeof import("silk-wasm")> {
  if (!silkModule) {
    silkModule = await import("silk-wasm");
  }
  return silkModule;
}

export async function silkToWav(silkData: Buffer): Promise<Buffer | undefined> {
  try {
    const silk = await getSilkModule();
    const result = await silk.decode(silkData, 24000);
    return Buffer.from(result.data);
  } catch {
    return undefined;
  }
}

export async function wavToSilk(wavData: Buffer): Promise<Buffer | undefined> {
  try {
    const silk = await getSilkModule();
    const result = await silk.encode(wavData, 24000);
    return Buffer.from(result.data);
  } catch {
    return undefined;
  }
}
