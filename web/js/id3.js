/**
 * 零依赖 ID3 元数据解析(仅 MP3):ID3v2.3/v2.4 头部切片解析 + ID3v1 尾部兜底。
 * 任何一步失败都回退文件名,绝不 throw。parseID3v2/parseID3v1 纯函数供测试直调。
 *
 * 已知限制:ID3v2.2(3 字节帧 id)不支持 → 落 ID3v1;帧级 unsync 不还原;
 * APIC 二次定向读上限 4MB(超出放弃封面仅取文本)。
 */

const TEXT_DECODERS = {
  0: () => new TextDecoder('latin1'),
  1: () => new TextDecoder('utf-16'), // 带 BOM,解码器自动剥除
  2: () => new TextDecoder('utf-16be'),
  3: () => new TextDecoder('utf-8'),
};

function decodeText(bytes, enc) {
  try {
    return (TEXT_DECODERS[enc] || TEXT_DECODERS[0])().decode(bytes);
  } catch {
    return '';
  }
}

/** 文本帧清洗:v2.4 多值分隔 \0 → 、 */
function cleanText(s, isV24) {
  let out = String(s || '').replace(/\0+$/, '').trim();
  if (isV24) out = out.split('\0').join('、');
  return out;
}

function syncsafe(u8, o) {
  if (u8.length < o + 4) return -1;
  if ((u8[o] | u8[o + 1] | u8[o + 2] | u8[o + 3]) & 0x80) return -1; // 非法 syncsafe
  return (u8[o] << 21) | (u8[o + 1] << 14) | (u8[o + 2] << 7) | u8[o + 3];
}

function be32(u8, o) {
  return (u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3];
}

/** 整 tag unsync 还原:0xFF 00 → 0xFF */
function deunsync(u8) {
  const out = new Uint8Array(u8.length);
  let w = 0;
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] === 0xff && u8[i + 1] === 0x00) {
      out[w++] = 0xff;
      i++;
    } else {
      out[w++] = u8[i];
    }
  }
  return out.subarray(0, w);
}

/** APIC 帧:编码 → mime → picture type → 描述串 → 图片字节 */
function parseAPIC(bytes) {
  if (bytes.length < 4) return null;
  const enc = bytes[0];
  let p = 1;
  let mime = '';
  while (p < bytes.length && bytes[p] !== 0) {
    mime += String.fromCharCode(bytes[p]);
    p++;
  }
  p++; // 跳过 \0
  if (!mime || mime === 'image/jpg') mime = 'image/jpeg';
  if (p >= bytes.length) return null;
  p++; // picture type
  if (enc === 1 || enc === 2) {
    // UTF-16 描述串:双字节扫 00 00
    while (p + 1 < bytes.length && !(bytes[p] === 0 && bytes[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < bytes.length && bytes[p] !== 0) p++;
    p++;
  }
  if (p >= bytes.length) return null;
  return { mime, bytes: bytes.subarray(p) };
}

/**
 * 解析 ID3v2(2.3/2.4)头 10 字节 + 帧区。
 * 返回 { name, artists, apic:{mime,bytes}|null, truncated, tagTotal } | null。
 * truncated = 帧数据越出缓冲(调用方可决定是否二次定向读);tagTotal = 完整 tag 区总长。
 */
export function parseID3v2(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 10 || String.fromCharCode(u8[0], u8[1], u8[2]) !== 'ID3') return null;
  const ver = u8[3];
  if (ver !== 3 && ver !== 4) return null; // v2.2 不支持
  const flags = u8[5];
  const tagSize = syncsafe(u8, 6);
  if (tagSize < 0) return null;
  const footer = ver === 4 && (flags & 0x10) ? 10 : 0;
  const tagTotal = 10 + tagSize + footer;

  let frames = u8.subarray(10, Math.min(10 + tagSize, u8.length));
  let off = 0;
  if (flags & 0x40) {
    // 扩展头(v2.3:4 字节 BE 长度不含自身;v2.4:syncsafe 长度含自身),在还原 unsync 前读
    if (frames.length < 4) return { name: '', artists: '', apic: null, truncated: true, tagTotal };
    off = ver === 3 ? 4 + be32(frames, 0) : syncsafe(frames, 0);
    if (off < 0 || off > frames.length) return { name: '', artists: '', apic: null, truncated: true, tagTotal };
  }
  frames = frames.subarray(off);
  if (flags & 0x80) frames = deunsync(frames);

  const out = { name: '', artists: '', apic: null };
  let truncated = tagTotal > u8.length;
  for (let p = 0; p + 10 <= frames.length; ) {
    const id = String.fromCharCode(frames[p], frames[p + 1], frames[p + 2], frames[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // 填充区,停止
    const size = ver === 3 ? be32(frames, p + 4) : syncsafe(frames, p + 4);
    if (size < 0) break;
    const dataStart = p + 10;
    const dataEnd = dataStart + size;
    if (dataEnd > frames.length) {
      truncated = true;
      break; // 截断帧:停在该帧
    }
    if (size > 0) {
      if (id === 'TIT2' && !out.name) {
        out.name = cleanText(decodeText(frames.subarray(dataStart + 1, dataEnd), frames[dataStart]), ver === 4);
      } else if (id === 'TPE1' && !out.artists) {
        out.artists = cleanText(decodeText(frames.subarray(dataStart + 1, dataEnd), frames[dataStart]), ver === 4);
      } else if (id === 'TPE2' && !out.artists) {
        out.artists = cleanText(decodeText(frames.subarray(dataStart + 1, dataEnd), frames[dataStart]), ver === 4);
      } else if (id === 'APIC' && !out.apic) {
        out.apic = parseAPIC(frames.subarray(dataStart, dataEnd));
      }
    }
    p = dataEnd;
  }
  return { ...out, truncated, tagTotal };
}

/** ID3v1 兜底:128 字节 'TAG',title=[3,33), artist=[33,63),latin1 */
export function parseID3v1(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 128 || String.fromCharCode(u8[0], u8[1], u8[2]) !== 'TAG') return null;
  const read = (a, b) =>
    new TextDecoder('latin1').decode(u8.subarray(a, b)).replace(/\0+$/, '').trim();
  return { name: read(3, 33), artists: read(33, 63) };
}

const MAX_HEAD = 256 * 1024; // 头部切片(大多数 tag 远小于此)
const MAX_TAG = 4 * 1024 * 1024; // APIC 二次定向读上限

/** 文件名回退:去扩展名 → 去轨道序号前缀 → trim,空则原文件名 */
export function fallbackName(fileName) {
  let n = String(fileName || '');
  n = n.replace(/\.[^.]+$/, '').replace(/^\d+[\s.\-_–—]+/, '').trim();
  return n || String(fileName || '');
}

/**
 * 读取音频文件元数据(头部切片 + 尾部 128B,不整读)。
 * 返回 { name, artists, coverBlob: Blob|null, format }。非 mp3 直接文件名回退,不发网络请求。
 */
export async function readAudioMeta(file) {
  const ext = (file?.name?.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const fallback = { name: fallbackName(file?.name), artists: '未知歌手', coverBlob: null, format: ext || 'unknown' };
  if (!file || !file.size || ext !== 'mp3') return fallback;
  try {
    const size = file.size;
    let v2 = parseID3v2(await file.slice(0, Math.min(size, MAX_HEAD)).arrayBuffer());
    if (v2 && v2.truncated && !v2.apic && v2.tagTotal <= MAX_TAG) {
      // APIC 在切片之外:二次定向读完整 tag 区重解析
      const again = parseID3v2(await file.slice(0, Math.min(size, v2.tagTotal)).arrayBuffer());
      if (again) v2 = again;
    }
    let name = '';
    let artists = '';
    if (v2) {
      name = v2.name;
      artists = v2.artists;
    }
    if (!name) {
      const v1 = parseID3v1(await file.slice(Math.max(0, size - 128), size).arrayBuffer());
      if (v1?.name) name = v1.name;
      if (v1?.artists) artists = v1.artists;
    }
    return {
      name: name || fallback.name,
      artists: artists || '未知歌手',
      coverBlob: v2?.apic ? new Blob([v2.apic.bytes], { type: v2.apic.mime }) : null,
      format: 'mp3',
    };
  } catch {
    return fallback;
  }
}
