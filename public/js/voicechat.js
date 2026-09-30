// Voice chat kiểu Discord cho mỗi bàn: WebRTC nối thẳng giữa các người chơi (mesh),
// Supabase Realtime chỉ dùng để báo ai đang trong voice (presence) và trao đổi tín hiệu kết nối (broadcast).
// Âm thanh không đi qua máy chủ.

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const SPEAK_LEVEL = 0.035; // ngưỡng RMS (micro của mình) coi là đang nói
const REMOTE_SPEAK_LEVEL = 0.03; // ngưỡng audioLevel trong thống kê WebRTC (người khác)
const SPEAK_HOLD_MS = 350;
const PREFS_KEY = 'rp-voice-v1';
const DEFAULT_PREFS = { muted: false, deafened: false, inputId: '', outputId: '', inputGain: 1, outputVolume: 1 };

function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; } catch { return { ...DEFAULT_PREFS }; }
}

let warnedNoMic = false;

export class VoiceChat {
  /**
   * @param sb       Supabase client
   * @param getMe    () => { id, name, picture }
   * @param onChange (state) => void — gọi mỗi khi trạng thái voice đổi
   */
  constructor(sb, getMe, onChange) {
    this.sb = sb;
    this.getMe = getMe;
    this.onChange = onChange;
    this.room = null;
    this.channel = null;
    this.joined = false;
    this.joining = false;
    this.error = '';
    this.prefs = loadPrefs();
    this.noMic = false;
    this.rawStream = null; // luồng từ micro
    this.chain = null; // { src, gain, dest } khi chỉnh âm lượng mic khác 100%
    this.ctx = null;
    this.localMeter = null;
    this.locked = false; // trình duyệt chưa cho phát tiếng (chưa có thao tác nào trên trang)
    this.peers = new Map(); // userId -> { pc, audio, level, pending: [], sender }
    this.members = new Map(); // userId -> { id, name, picture, muted, deafened, noMic }
    this.speaking = new Map(); // userId -> thời điểm cuối cùng nghe thấy tiếng
    this.meterTimer = null;
    window.addEventListener('pagehide', () => this.setRoom(null));
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.emit());
  }

  get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);
  }

  get muted() { return this.prefs.muted; }
  get deafened() { return this.prefs.deafened; }

  /** Mic thật sự phát khi: có micro, không tắt mic, không tắt loa. */
  get micLive() {
    return !!this.rawStream && !this.prefs.muted && !this.prefs.deafened;
  }

  get canPickOutput() {
    return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  }

  snapshot() {
    const me = this.getMe()?.id;
    const now = performance.now();
    return {
      room: this.room,
      joined: this.joined,
      joining: this.joining,
      muted: this.prefs.muted,
      deafened: this.prefs.deafened,
      noMic: this.noMic,
      locked: this.locked,
      error: this.error,
      connecting: [...this.peers.values()].some((p) => p.pc.connectionState !== 'connected'),
      members: [...this.members.values()].map((m) => ({
        ...m,
        me: m.id === me,
        speaking: (this.speaking.get(m.id) || 0) > now - SPEAK_HOLD_MS,
      })),
    };
  }

  emit() {
    this.onChange?.(this.snapshot());
  }

  savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* không sao */ }
  }

  // ───────── phòng (bàn) ─────────
  /** Theo dõi voice của bàn `room` (chưa bật mic). `null` = rời hẳn. */
  setRoom(room) {
    if (room === this.room) return;
    this.leave();
    if (this.channel) { this.sb.removeChannel(this.channel); this.channel = null; }
    this.room = room;
    this.members.clear();
    if (room) {
      const me = this.getMe();
      const ch = this.sb.channel(`rp-voice-${room}`, { config: { presence: { key: me.id }, broadcast: { self: false } } });
      ch.on('presence', { event: 'sync' }, () => this.onSync())
        .on('broadcast', { event: 'signal' }, ({ payload }) => this.onSignal(payload).catch(() => {}))
        .subscribe();
      this.channel = ch;
    }
    this.emit();
  }

  // ───────── vào / rời voice ─────────
  async join() {
    if (!this.room || this.joined || this.joining || !this.supported) return;
    this.joining = true;
    this.error = '';
    this.emit();
    const room = this.room;
    await this.openMic();
    if (room !== this.room) { this.closeMic(); this.joining = false; this.emit(); return; }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume?.().catch(() => {});
    this.locked = this.ctx.state !== 'running';
    this.rebuildChain();
    this.joined = true;
    this.joining = false;
    await this.track();
    this.startMeters();
    this.onSync();
  }

  leave() {
    if (!this.joined && !this.joining) return;
    this.joined = false;
    this.joining = false;
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.channel?.untrack().catch(() => {});
    this.closeMic();
    clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.chain = null;
    this.localMeter = null;
    this.speaking.clear();
    this.emit();
  }

  /** Bật micro theo thiết bị đã chọn. Không có micro / bị chặn thì vẫn vào để nghe. */
  async openMic() {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const want = this.prefs.inputId;
    try {
      this.rawStream = await navigator.mediaDevices.getUserMedia({ audio: want ? { ...audio, deviceId: { exact: want } } : audio })
        .catch((e) => {
          if (!want) throw e;
          this.prefs.inputId = ''; // micro đã chọn không còn: quay về mặc định
          return navigator.mediaDevices.getUserMedia({ audio });
        });
      this.noMic = false;
    } catch {
      this.rawStream = null;
      this.noMic = true;
      if (!warnedNoMic) {
        warnedNoMic = true;
        this.error = 'Không dùng được micro (chưa cấp quyền hoặc không có micro). Bạn vẫn nghe được.';
      }
    }
  }

  closeMic() {
    this.rawStream?.getTracks().forEach((t) => t.stop());
    this.rawStream = null;
    this.chain?.src.disconnect();
  }

  /** Luồng gửi đi: micro gốc, hoặc qua bộ khuếch đại khi âm lượng mic khác 100%. */
  rebuildChain() {
    this.chain?.src.disconnect();
    this.chain = null;
    this.localMeter = null;
    if (!this.rawStream || !this.ctx) { this.applyLocalTrack(); return; }
    this.localMeter = this.meter(this.rawStream);
    if (this.prefs.inputGain !== 1) {
      const src = this.ctx.createMediaStreamSource(this.rawStream);
      const gain = this.ctx.createGain();
      gain.gain.value = this.prefs.inputGain;
      const dest = this.ctx.createMediaStreamDestination();
      src.connect(gain).connect(dest);
      this.chain = { src, gain, dest };
    }
    this.applyLocalTrack();
    for (const p of this.peers.values()) p.sender?.replaceTrack(this.sendTrack());
  }

  sendTrack() {
    return (this.chain ? this.chain.dest.stream : this.rawStream)?.getAudioTracks()[0] || null;
  }

  applyLocalTrack() {
    const live = this.micLive;
    this.rawStream?.getAudioTracks().forEach((t) => { t.enabled = live; });
    this.chain?.dest.stream.getAudioTracks().forEach((t) => { t.enabled = live; });
  }

  /** Trình duyệt chặn phát tiếng khi chưa có thao tác nào: thử lại ở lần bấm/gõ đầu tiên. */
  unlock() {
    if (!this.joined) return;
    this.ctx?.resume?.().catch(() => {});
    for (const p of this.peers.values()) if (p.audio.srcObject && p.audio.paused) p.audio.play().catch(() => {});
    if (this.locked) {
      this.locked = false;
      this.emit();
    }
  }

  // ───────── mic / loa ─────────
  async toggleMic() {
    if (!this.joined) return;
    if (this.noMic) {
      warnedNoMic = false;
      await this.openMic();
      if (this.noMic) this.error = 'Trình duyệt vẫn chặn micro. Bấm vào biểu tượng ổ khóa cạnh địa chỉ web để cho phép.';
      else { this.error = ''; this.prefs.muted = false; this.rebuildChain(); }
    } else if (this.prefs.deafened) {
      // đang tắt loa mà bấm mic: bật lại cả loa lẫn mic, như Discord
      this.prefs.deafened = false;
      this.prefs.muted = false;
    } else {
      this.prefs.muted = !this.prefs.muted;
    }
    this.applyAll();
    await this.track();
  }

  async toggleSpeaker() {
    if (!this.joined) return;
    this.prefs.deafened = !this.prefs.deafened;
    this.applyAll();
    await this.track();
  }

  applyAll() {
    this.applyLocalTrack();
    for (const p of this.peers.values()) this.applyOutput(p.audio);
    this.savePrefs();
    this.emit();
  }

  applyOutput(audio) {
    audio.muted = this.prefs.deafened;
    audio.volume = Math.max(0, Math.min(1, this.prefs.outputVolume));
    if (this.canPickOutput && (audio.sinkId || '') !== this.prefs.outputId) audio.setSinkId(this.prefs.outputId).catch(() => {});
  }

  // ───────── thiết bị & âm lượng ─────────
  async listDevices() {
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const pick = (kind) => all.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Micro' : 'Loa'} ${i + 1}` }));
    return {
      inputs: pick('audioinput'),
      outputs: this.canPickOutput ? pick('audiooutput') : [],
      inputId: this.prefs.inputId,
      outputId: this.prefs.outputId,
      inputGain: this.prefs.inputGain,
      outputVolume: this.prefs.outputVolume,
      canPickOutput: this.canPickOutput,
    };
  }

  async setInput(deviceId) {
    this.prefs.inputId = deviceId;
    this.savePrefs();
    if (!this.joined) return;
    this.closeMic();
    await this.openMic();
    this.rebuildChain();
    await this.track();
    this.emit();
  }

  setOutput(deviceId) {
    this.prefs.outputId = deviceId;
    this.applyAll();
  }

  setInputGain(v) {
    const was = this.prefs.inputGain;
    this.prefs.inputGain = Math.max(0, Math.min(2, v));
    this.savePrefs();
    if (!this.joined) return;
    if (this.chain && this.prefs.inputGain !== 1) this.chain.gain.gain.value = this.prefs.inputGain;
    else if ((was === 1) !== (this.prefs.inputGain === 1) || !this.chain) this.rebuildChain();
  }

  setOutputVolume(v) {
    this.prefs.outputVolume = Math.max(0, Math.min(1, v));
    this.applyAll();
  }

  /** Mức tiếng micro hiện tại (0..1) để hiện thanh thử mic. */
  inputLevel() {
    return this.localMeter ? Math.min(1, this.localMeter.level() * 4 * this.prefs.inputGain) : 0;
  }

  track() {
    if (!this.channel || !this.joined) return Promise.resolve();
    const me = this.getMe();
    return this.channel.track({
      id: me.id, name: me.name, picture: me.picture || '',
      muted: !this.micLive, deafened: this.prefs.deafened, noMic: this.noMic,
    }).catch(() => {});
  }

  // ───────── presence ─────────
  onSync() {
    if (!this.channel) return;
    const state = this.channel.presenceState();
    const members = new Map();
    for (const [key, metas] of Object.entries(state)) {
      const m = metas[metas.length - 1];
      if (m) members.set(key, { id: key, name: m.name, picture: m.picture, muted: !!m.muted, deafened: !!m.deafened, noMic: !!m.noMic });
    }
    this.members = members;
    if (this.joined) {
      const me = this.getMe().id;
      // Người có id nhỏ hơn chủ động gọi, tránh hai bên cùng gọi nhau.
      for (const id of members.keys()) if (id !== me && !this.peers.has(id) && me < id) this.call(id);
      for (const id of [...this.peers.keys()]) if (!members.has(id)) this.dropPeer(id);
    }
    this.emit();
  }

  // ───────── WebRTC ─────────
  makePeer(id, caller) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const audio = new Audio();
    audio.autoplay = true;
    this.applyOutput(audio);
    const peer = { pc, audio, level: 0, pending: [], sender: null };
    // Bên gọi tạo sẵn kênh âm thanh; bên nhận dùng kênh do lời mời (offer) tạo ra, xem attachMic().
    if (caller) this.attachMic(peer, pc.addTransceiver('audio', { direction: 'sendrecv' }));
    pc.onicecandidate = (e) => { if (e.candidate) this.send(id, 'ice', e.candidate.toJSON()); };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      audio.play().catch(() => { this.locked = true; this.emit(); });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this.dropPeer(id);
        const me = this.getMe().id;
        if (this.joined && me < id && this.members.has(id)) setTimeout(() => { if (this.joined && !this.peers.has(id) && this.members.has(id)) this.call(id); }, 1500);
      }
      this.emit();
    };
    this.peers.set(id, peer);
    return peer;
  }

  attachMic(peer, transceiver) {
    transceiver.direction = 'sendrecv';
    peer.sender = transceiver.sender;
    const track = this.sendTrack();
    if (track) transceiver.sender.replaceTrack(track);
  }

  async call(id) {
    const peer = this.makePeer(id, true);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.send(id, 'offer', { type: offer.type, sdp: offer.sdp });
  }

  async onSignal(msg) {
    const me = this.getMe()?.id;
    if (!this.joined || !msg || msg.to !== me) return;
    const { from, type, data } = msg;
    let peer = this.peers.get(from);
    if (type === 'offer') {
      if (peer) this.dropPeer(from);
      peer = this.makePeer(from, false);
      await peer.pc.setRemoteDescription(data);
      const tr = peer.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio');
      if (tr) this.attachMic(peer, tr);
      await this.flush(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.send(from, 'answer', { type: answer.type, sdp: answer.sdp });
    } else if (type === 'answer' && peer) {
      await peer.pc.setRemoteDescription(data);
      await this.flush(peer);
    } else if (type === 'ice' && peer) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data).catch(() => {});
      else peer.pending.push(data);
    }
  }

  async flush(peer) {
    for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  send(to, type, data) {
    this.channel?.send({ type: 'broadcast', event: 'signal', payload: { from: this.getMe().id, to, type, data } });
  }

  dropPeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    p.pc.onconnectionstatechange = null;
    p.pc.close();
    p.audio.srcObject = null;
    this.speaking.delete(id);
  }

  // ───────── đo âm lượng (ai đang nói) ─────────
  meter(stream) {
    if (!this.ctx) return null;
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    return {
      level() {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        return Math.sqrt(sum / buf.length);
      },
    };
  }

  async readRemoteLevels() {
    for (const p of this.peers.values()) {
      if (p.pc.connectionState !== 'connected') continue;
      const stats = await p.pc.getStats().catch(() => null);
      stats?.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && typeof r.audioLevel === 'number') p.level = r.audioLevel;
      });
    }
  }

  startMeters() {
    clearInterval(this.meterTimer);
    let last = '';
    let reading = false;
    this.meterTimer = setInterval(async () => {
      const now = performance.now();
      const me = this.getMe()?.id;
      if (this.localMeter && this.micLive && this.localMeter.level() * this.prefs.inputGain > SPEAK_LEVEL) this.speaking.set(me, now);
      if (!reading) {
        reading = true;
        await this.readRemoteLevels();
        reading = false;
      }
      if (!this.prefs.deafened) for (const [id, p] of this.peers) if (p.level > REMOTE_SPEAK_LEVEL) this.speaking.set(id, now);
      const sig = [...this.speaking].filter(([, t]) => t > now - SPEAK_HOLD_MS).map(([id]) => id).sort().join(',');
      if (sig !== last) { last = sig; this.emit(); }
    }, 120);
  }
}
