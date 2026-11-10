// Minimal typings for the parts of libheif-js's ESM bundle the app uses.
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  export interface HeifImage {
    get_width(): number
    get_height(): number
    is_primary(): boolean
    display(
      target: { data: Uint8ClampedArray; width: number; height: number },
      callback: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
    ): void
    free(): void
  }
  export interface LibHeif {
    HeifDecoder: new () => { decode(bytes: Uint8Array | ArrayBuffer): HeifImage[] }
  }
  const factory: () => LibHeif
  export default factory
}
