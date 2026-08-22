/**
 * 电影运镜(纯数学,零 DOM/THREE 依赖):轨道 = user 基准 + cine 偏移。
 *
 * 只算偏移,user 基准轨道由 visualizer3d 合成:
 * - 节拍 kick:快攻慢放(瞬时攻击、指数衰减释放),幅度取新旧较大者,方向随机
 * - 慢正弦漂移:闲时 theta/phi/roll 微幅起伏(待机时降至 35%,保留壁纸感)
 * - FOV punch:节拍推镜(代替真实推轨)
 * 参数经 fx.js 管线热更新(visualizer3d._applyFx 转发);降载流程写 lowPower。
 */
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const PARAM_KEYS = ['cineEnabled', 'cineShake', 'cineIdle', 'cineKick', 'cinePunch'];
const DECAY_K = 5.5;       // 衰减系数(时间常数 ~0.18s,0.45s 后残余 <10%)
const BEAT_COOLDOWN = 450; // 节拍最小间隔(ms),防连打堆积
const FOV_PUNCH_GAIN = 2.4; // punch → FOV 收缩(度)

export class Cameraman {
  constructor(fx = {}) {
    this.params = { cineEnabled: true, cineShake: 0.6, cineIdle: 0.5, cineKick: 0.6, cinePunch: 0.55 };
    this.lowPower = false;
    this.setParams(fx);
    // 包络(带符号:方向随机;radiusOffset 除外,保持推近为正)
    this.punch = 0;
    this.radiusKick = 0;
    this.thetaKick = 0;
    this.phiKick = 0;
    this.rollKick = 0;
    this.t = 0;
    this._lastBeatAt = -1e9;
    // 每帧合成输出(visualizer3d 读取)
    this.radiusOffset = 0;
    this.thetaOffset = 0;
    this.phiOffset = 0;
    this.rollOffset = 0;
    this.fovPunch = 0;
  }

  /** 参数热更新:只收认识的键;lowPower 由降载流程写入,不进 fx */
  setParams(partial) {
    if (!partial) return;
    for (const key of PARAM_KEYS) {
      if (key in partial) this.params[key] = partial[key];
    }
    if ('lowPower' in partial) this.lowPower = !!partial.lowPower;
  }

  /** 节拍事件(strength 0-1):kick/punch 取当前值与新值的较大幅度,方向随机 */
  beat(strength) {
    if (!this.params.cineEnabled) return;
    const now = performance.now();
    if (now - this._lastBeatAt < BEAT_COOLDOWN) return;
    this._lastBeatAt = now;
    const s = clamp(strength, 0, 1);
    const shake = this.params.cineShake;
    const kick = this.params.cineKick * (this.lowPower ? 0.6 : 1);
    const punch = this.params.cinePunch * (this.lowPower ? 0.6 : 1);
    const dir = (base) => base * (Math.random() < 0.5 ? -1 : 1);
    this._kickField('punch', s * punch);
    this._kickField('radiusKick', s * 0.09 * shake * kick);
    this._kickField('thetaKick', dir(s * 0.05 * shake * kick));
    this._kickField('phiKick', dir(s * 0.04 * shake * kick));
    this._kickField('rollKick', dir(s * 0.10 * shake * kick));
  }

  /** 幅度比较写入:新值幅度更大才替换(带符号比较) */
  _kickField(name, val) {
    if (Math.abs(val) > Math.abs(this[name])) this[name] = val;
  }

  /** 每帧推进:指数衰减 + 慢正弦漂移;cineEnabled=false 时输出恒 0 */
  update(dt, active = true) {
    this.t += dt;
    const decay = Math.exp(-dt * DECAY_K);
    this.punch *= decay;
    this.radiusKick *= decay;
    this.thetaKick *= decay;
    this.phiKick *= decay;
    this.rollKick *= decay;

    if (!this.params.cineEnabled) {
      this.radiusOffset = this.thetaOffset = this.phiOffset = this.rollOffset = this.fovPunch = 0;
      return;
    }
    const idle = this.params.cineIdle * (active ? 1 : 0.35);
    this.thetaOffset = Math.sin(this.t * 0.08) * 0.012 * idle + this.thetaKick;
    this.phiOffset = Math.cos(this.t * 0.07) * 0.010 * idle + this.phiKick;
    this.rollOffset = Math.sin(this.t * 0.05) * 0.008 * idle + this.rollKick;
    this.radiusOffset = this.radiusKick; // 慢漂移不做半径,防整体缩放抖动
    this.fovPunch = this.punch * FOV_PUNCH_GAIN;
  }
}
