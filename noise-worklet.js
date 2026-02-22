/* noise-worklet.js */
class NoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "type", defaultValue: 0, minValue: 0, maxValue: 2 }, // 0=white,1=pink,2=brown
      { name: "level", defaultValue: 0.2, minValue: 0, maxValue: 1 }
    ];
  }

  constructor() {
    super();
    // Pink noise (Paul Kellet) state
    this.p0 = this.p1 = this.p2 = this.p3 = this.p4 = this.p5 = this.p6 = 0;
    // Brown noise integrator
    this.brown = 0;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const ch0 = output[0];
    const ch1 = output[1] || output[0];

    const typeArr = parameters.type;
    const levelArr = parameters.level;

    for (let i = 0; i < ch0.length; i++) {
      const t = typeArr.length > 1 ? typeArr[i] : typeArr[0];
      const level = levelArr.length > 1 ? levelArr[i] : levelArr[0];

      // white base
      let white = (Math.random() * 2 - 1);

      let sample = white;

      if (t < 0.5) {
        // white
        sample = white;
      } else if (t < 1.5) {
        // pink noise (Paul Kellet filter)
        this.p0 = 0.99886 * this.p0 + white * 0.0555179;
        this.p1 = 0.99332 * this.p1 + white * 0.0750759;
        this.p2 = 0.96900 * this.p2 + white * 0.1538520;
        this.p3 = 0.86650 * this.p3 + white * 0.3104856;
        this.p4 = 0.55000 * this.p4 + white * 0.5329522;
        this.p5 = -0.7616 * this.p5 - white * 0.0168980;
        const pink = this.p0 + this.p1 + this.p2 + this.p3 + this.p4 + this.p5 + this.p6 + white * 0.5362;
        this.p6 = white * 0.115926;
        sample = pink * 0.11; // normalization
      } else {
        // brown noise (integrated white)
        this.brown = (this.brown + white * 0.02);
        // soft clamp
        if (this.brown > 1) this.brown = 1;
        if (this.brown < -1) this.brown = -1;
        sample = this.brown * 1.5;
      }

      // final level
      const out = sample * level;

      ch0[i] = out;
      ch1[i] = out;
    }

    return true;
  }
}

registerProcessor("noise-processor", NoiseProcessor);
