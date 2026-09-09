// tunajs ships types at dist/types/tuna.d.ts but its package.json `exports`
// map does not point at them, so TypeScript resolves the import as `any`
// under moduleResolution "bundler". Declared here instead of loosening the
// compiler for the whole project.
//
// The surface we use is deliberately narrow: a Tuna instance is a bag of
// effect constructors, and every effect is an object with an `input` and an
// `output` AudioNode plus settable properties. `audioFx.tunaNodes()` is what
// knows which properties each effect actually takes.
declare module "tunajs" {
  interface TunaEffectNode {
    input: AudioNode;
    output: AudioNode;
    bypass: boolean;
    [prop: string]: unknown;
  }
  type TunaEffectCtor = new (props?: Record<string, unknown>) => TunaEffectNode;

  export default class Tuna {
    constructor(context: BaseAudioContext);
    [effect: string]: unknown;
    Filter: TunaEffectCtor;
    Compressor: TunaEffectCtor;
    Delay: TunaEffectCtor;
    Chorus: TunaEffectCtor;
    Tremolo: TunaEffectCtor;
  }
}
