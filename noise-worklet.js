/* noise-worklet.js
   Upraveno pro mobilní prohlížeče:
   - vlastní rychlý generátor náhodných čísel místo Math.random() v každém vzorku
   - měkké omezení špiček (soft clip), aby telefonní reproduktor/DAC nepraskal
   - u bílého šumu jemné vyhlazení nejvyšších frekvencí, aby se víc podobal nahrávce
   - malé plynulé dorovnávání levelu přímo ve workletu
*/
class NoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "type",  defaultValue: 0,   minValue: 0, maxValue: 2 }, // 0=white,1=pink,2=brown
      { name: "level", defaultValue: 0.18, minValue: 0, maxValue: 1 },
      { name: "tone",  defaultValue: 0.55, minValue: 0, maxValue: 1 }  // 0=jemnější, 1=ostřejší
    ];
  }

  constructor() {
    super();

    // Pink noise (Paul Kellet) state
    this.p0 = this.p1 = this.p2 = this.p3 = this.p4 = this.p5 = this.p6 = 0;

    // Brown noise integrator
    this.brown = 0;

    // Stav pro jemnější bílý šum
    this.whiteLp1 = 0;
    this.whiteLp2 = 0;
    this.dcX = 0;
    this.dcY = 0;

    // Plynulé dorovnání levelu
    this.levelSmooth = 0;

    // Xorshift seed – stabilní a rychlý na mobilech
    this.seed = 0x12345678;
  }

  randWhite() {
    // xorshift32 -> rozsah přibližně -1 až +1
    let x = this.seed | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x | 0;
    return ((x >>> 0) / 2147483648) - 1;
  }

  softClip(x) {
    // Jemné omezení špiček bez tvrdého ořezu
    return x / (1 + Math.abs(x) * 0.35);
  }

  dcBlock(x) {
    const y = x - this.dcX + 0.995 * this.dcY;
    this.dcX = x;
    this.dcY = y;
    return y;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const ch0 = output[0];
    const ch1 = output[1] || output[0];

    const typeArr = parameters.type;
    const levelArr = parameters.level;
    const toneArr = parameters.tone;

    for (let i = 0; i < ch0.length; i++) {
      const t = typeArr.length > 1 ? typeArr[i] : typeArr[0];
      const targetLevel = levelArr.length > 1 ? levelArr[i] : levelArr[0];
      const tone = toneArr.length > 1 ? toneArr[i] : toneArr[0];

      // Plynulé změny hlasitosti šumu uvnitř bufferu
      this.levelSmooth += (targetLevel - this.levelSmooth) * 0.0025;

      const white = this.randWhite();
      let sample = white;

      if (t < 0.5) {
        // „Bílý“ šum pro telefon: pořád šum, ale ne úplně ostrý digitální prach.
        // Při vyšší intenzitě je ostřejší, při nižší víc jako nahrávka/ventilační šum.
        const a1 = 0.025 + 0.18 * tone;
        const a2 = 0.010 + 0.08 * tone;
        this.whiteLp1 += a1 * (white - this.whiteLp1);
        this.whiteLp2 += a2 * (this.whiteLp1 - this.whiteLp2);

        // Směs čistého a vyhlazeného šumu.
        const bright = 0.22 + 0.34 * tone;
        sample = this.whiteLp2 * (1 - bright) + this.whiteLp1 * bright + white * (0.10 + 0.10 * tone);
        sample *= 1.85;
      } else if (t < 1.5) {
        // Pink noise (Paul Kellet filter)
        this.p0 = 0.99886 * this.p0 + white * 0.0555179;
        this.p1 = 0.99332 * this.p1 + white * 0.0750759;
        this.p2 = 0.96900 * this.p2 + white * 0.1538520;
        this.p3 = 0.86650 * this.p3 + white * 0.3104856;
        this.p4 = 0.55000 * this.p4 + white * 0.5329522;
        this.p5 = -0.7616 * this.p5 - white * 0.0168980;
        const pink = this.p0 + this.p1 + this.p2 + this.p3 + this.p4 + this.p5 + this.p6 + white * 0.5362;
        this.p6 = white * 0.115926;
        sample = pink * 0.11;
      } else {
        // Brown noise (integrated white)
        this.brown = this.brown * 0.995 + white * 0.018;
        if (this.brown > 1) this.brown = 1;
        if (this.brown < -1) this.brown = -1;
        sample = this.brown * 1.35;
      }

      sample = this.dcBlock(sample);
      sample = this.softClip(sample * this.levelSmooth);

      ch0[i] = sample;
      ch1[i] = sample;
    }

    return true;
  }
}

registerProcessor("noise-processor", NoiseProcessor);
