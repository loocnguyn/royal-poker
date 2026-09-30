// Voice chat kiểu Discord cho mỗi bàn: WebRTC nối thẳng giữa các người chơi (mesh),
// Supabase Realtime chỉ dùng để báo ai đang trong voice (presence) và trao đổi tín hiệu kết nối (broadcast).
// Âm thanh không đi qua máy chủ.

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const SPEAK_LEVEL = 0.035; // ngưỡng RMS (micro của mình) coi là đang nói
const REMOTE_SPEAK_LEVEL = 0.03; // ngưỡng audioLevel trong thống kê WebRTC (người khác)
const SPEAK_HOLD_MS = 350;
const PREFS_KEY = 'rp-voice-v1';

function loadPrefs() {
  try { return { muted: false, deafened: false, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; } catch { return { muted: false, deafened: false }; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* không sao */ }
}

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
    const prefs = loadPrefs();
    this.muted = prefs.muted;
    this.deafened = prefs.deafened;
    this.noMic = false;
    this.stream = null;
    this.ctx = null;
    this.localMeter = null;
    this.peers = new Map(); // userId -> { pc, audio, meter, pending: [] }
    this.members = new Map(); // userId -> { id, name, picture, muted, deafened, noMic }
    this.speaking = new Map(); // userId -> thời điểm cuối cùng nghe thấy tiếng
    this.meterTimer = null;
    window.addEventListener('pagehide', () => this.setRoom(null));
  }

  get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);
  }

  snapshot() {
    const me = this.getMe()?.id;
    const now = performance.now();
    return {
      room: this.room,
      joined: this.joined,
      joining: this.joining,
      muted: this.muted,
      deafened: this.deafened,
      noMic: this.noMic,
      error: this.error,
      members: [...this.members.values()].map((m) => ({
        ...m,
        me: m.id === me,
        speaking: (this.speaking.get(m.id) || 0) > now - SPEAK_HOLD_MS,
        connected: m.id === me ? this.joined : this.peers.get(m.id)?.pc.connectionState === 'connected',
      })),
    };
  }

  emit() {
    this.onChange?.(this.snapshot());
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
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.noMic = false;
    } catch {
      // Không có micro hoặc bị chặn quyền: vẫn cho vào để nghe.
      this.stream = null;
      this.noMic = true;
      this.error = 'Không dùng được micro (chưa cấp quyền hoặc không có micro). Bạn vẫn nghe được.';
    }
    if (room !== this.room) { this.stopStream(); this.joining = false; return; }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume?.().catch(() => {});
    if (this.stream) this.localMeter = this.meter(this.stream);
    this.applyLocalTrack();
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
    this.stopStream();
    clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.localMeter = null;
    this.speaking.clear();
    this.emit();
  }

  stopStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  // ───────── mic / loa ─────────
  async toggleMic() {
    if (!this.joined) return;
    if (this.noMic) {
      // thử xin quyền lại
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        this.noMic = false;
        this.error = '';
        this.muted = false;
        this.localMeter = this.meter(this.stream);
        for (const p of this.peers.values()) p.sender?.replaceTrack(this.stream.getAudioTracks()[0]);
      } catch {
        this.error = 'Trình duyệt vẫn chặn micro. Bấm vào biểu tượng ổ khóa cạnh địa chỉ web để cho phép.';
      }
    } else if (this.deafened) {
      // đang tắt loa mà bấm mic: bật lại cả loa lẫn mic, như Discord
      this.deafened = false;
      this.muted = false;
    } else {
      this.muted = !this.muted;
    }
    this.applyLocalTrack();
    this.applyDeafen();
    this.persist();
    await this.track();
    this.emit();
  }

  async toggleSpeaker() {
    if (!this.joined) return;
    this.deafened = !this.deafened;
    this.applyDeafen();
    this.applyLocalTrack();
    this.persist();
    await this.track();
    this.emit();
  }

  /** Mic thật sự phát khi: có micro, không tắt mic, không tắt loa. */
  get micLive() {
    return !!this.stream && !this.muted && !this.deafened;
  }

  applyLocalTrack() {
    const t = this.stream?.getAudioTracks()[0];
    if (t) t.enabled = this.micLive;
  }

  applyDeafen() {
    for (const p of this.peers.values()) p.audio.muted = this.deafened;
  }

  persist() {
    savePrefs({ muted: this.muted, deafened: this.deafened });
  }

  track() {
    if (!this.channel || !this.joined) return Promise.resolve();
    const me = this.getMe();
    return this.channel.track({
      id: me.id, name: me.name, picture: me.picture || '',
      muted: !this.micLive, deafened: this.deafened, noMic: this.noMic,
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
    audio.muted = this.deafened;
    const peer = { pc, audio, level: 0, pending: [], sender: null };
    // Bên gọi tạo sẵn kênh âm thanh; bên nhận dùng kênh do lời mời (offer) tạo ra, xem attachMic().
    if (caller) this.attachMic(peer, pc.addTransceiver('audio', { direction: 'sendrecv' }));
    pc.onicecandidate = (e) => { if (e.candidate) this.send(id, 'ice', e.candidate.toJSON()); };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      audio.srcObject = stream;
      audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed') {
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
    const track = this.stream?.getAudioTracks()[0];
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
      disconnect() { try { src.disconnect(); } catch { /* đã ngắt */ } },
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
      if (this.localMeter && this.micLive && this.localMeter.level() > SPEAK_LEVEL) this.speaking.set(me, now);
      if (!reading) {
        reading = true;
        await this.readRemoteLevels();
        reading = false;
      }
      if (!this.deafened) for (const [id, p] of this.peers) if (p.level > REMOTE_SPEAK_LEVEL) this.speaking.set(id, now);
      const sig = [...this.speaking].filter(([, t]) => t > now - SPEAK_HOLD_MS).map(([id]) => id).sort().join(',');
      if (sig !== last) { last = sig; this.emit(); }
    }, 120);
  }
}
