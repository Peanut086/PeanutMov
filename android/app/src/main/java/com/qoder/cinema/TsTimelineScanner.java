package com.qoder.cinema;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
/** 只读扫描合并 TS 的真实视频时间轴，用于生成本地 HLS BYTERANGE 索引。 */
public final class TsTimelineScanner {
    private static final long WRAP = 1L << 33;
    private static final long DISCONTINUITY_GAP_TICKS = 90_000L;
    private static final int MAX_REGIONS = 10_000;
    private static final int MAX_PID = 8191;

    private TsTimelineScanner() {
    }

    public static JSONObject scan(File file) throws IOException, JSONException {
        JSONObject result = new JSONObject();
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            long size = raf.length();
            result.put("fileSize", size);
            if (size <= 0) return failure(result, "not-ts", 0, -1, size);

            int probeLen = (int) Math.min(size, 2L * 1024 * 1024);
            byte[] probe = new byte[probeLen];
            raf.readFully(probe);
            int start = -1;
            int packetSize = 188;
            outer:
            for (int i = 0; i <= Math.min(Math.max(0, probeLen - 188), 8192); i++) {
                for (int candidate : new int[]{188, 192}) {
                    int syncOffset = candidate == 192 ? 4 : 0;
                    if (i + syncOffset >= probeLen || probe[i + syncOffset] != 0x47) continue;
                    int available = (probeLen - i) / candidate;
                    if (available < 2) continue;
                    int checks = Math.min(5, available);
                    int matched = 1;
                    for (int k = 1; k < checks; k++) {
                        long at = (long) i + syncOffset + (long) k * candidate;
                        if (at < probeLen && probe[(int) at] == 0x47) matched++;
                    }
                    if (matched >= Math.min(3, checks)) {
                        start = i;
                        packetSize = candidate;
                        break outer;
                    }
                }
            }
            if (start < 0) return failure(result, "not-ts", 0, -1, size);
            if (start != 0) {
                result.put("alignedStart", start);
                return failure(result, "prefix", packetSize, start, size);
            }

            int syncOffset = packetSize == 192 ? 4 : 0;
            int blockSize = packetSize * 512;
            byte[] block = new byte[blockSize];
            Clock[] clocks = new Clock[MAX_PID + 1];
            Clock[] ptsClocks = new Clock[MAX_PID + 1];
            Clock[] dtsClocks = new Clock[MAX_PID + 1];
            PesHeader[] pesHeaders = new PesHeader[MAX_PID + 1];
            Timeline videoTimeline = new Timeline();
            Timeline pcrTimeline = new Timeline();
            long checked = 0;
            long bad = 0;
            long firstBad = -1;
            long position = 0;

            while (position + packetSize <= size) {
                int count = (int) Math.min(blockSize, size - position);
                count -= count % packetSize;
                if (count <= 0) break;
                raf.seek(position);
                raf.readFully(block, 0, count);
                for (int i = 0; i + packetSize <= count; i += packetSize) {
                    int packet = i + syncOffset;
                    if (block[packet] != 0x47) {
                        bad++;
                        if (firstBad < 0) firstBad = position + i;
                        continue;
                    }
                    checked++;
                    inspectPacket(block, packet, packetSize - syncOffset, position + i,
                        clocks, ptsClocks, dtsClocks, pesHeaders, videoTimeline, pcrTimeline);
                }
                position += count;
            }
            long tail = size - position;
            if (bad > 0) {
                result.put("alignedStart", 0);
                result.put("badPackets", bad);
                return failure(result, "corrupt", packetSize, firstBad, tail);
            }
            if (tail != 0) return failure(result, "truncated", packetSize, -1, tail);

            boolean hasVideoTimeline = videoTimeline.hasPositiveDuration();
            Timeline selected = hasVideoTimeline ? videoTimeline : pcrTimeline;
            String source = hasVideoTimeline ? "video-pts" : pcrTimeline.hasPositiveDuration() ? "pcr" : "";
            result.put("packetSize", packetSize);
            result.put("alignedStart", 0);
            result.put("totalPackets", checked);
            result.put("badPackets", 0);
            result.put("firstBadOffset", -1);
            result.put("tailBytes", 0);
            result.put("timestampCount", selected.count);
            result.put("timelineSource", source);
            if (selected.count == 0 || selected.regions.isEmpty()) {
                result.put("ok", false);
                result.put("timelineReliable", false);
                result.put("verdict", "no-timeline");
                result.put("durationUs", 0);
                result.put("segments", new JSONArray());
                return result;
            }

            JSONArray segments = new JSONArray();
            long totalUs = 0;
            boolean reliable = true;
            for (int i = 0; i < selected.regions.size(); i++) {
                Region region = selected.regions.get(i);
                long duration = (region.maxTimestamp - region.minTimestamp) * 1000 / 90;
                if (duration <= 0) reliable = false;
                totalUs += duration;
                JSONObject segment = new JSONObject();
                segment.put("offset", region.offset);
                segment.put("durationUs", duration);
                segment.put("discontinuity", i > 0);
                segments.put(segment);
            }
            if (selected.overflow) reliable = false;
            result.put("ok", reliable && totalUs > 0);
            result.put("timelineReliable", reliable && totalUs > 0);
            result.put("verdict", reliable && totalUs > 0 ? "ok" : "no-timeline");
            result.put("durationUs", totalUs);
            result.put("discontinuities", Math.max(0, selected.regions.size() - 1));
            result.put("segments", segments);
            return result;
        }
    }

    private static JSONObject failure(JSONObject result, String verdict, int packetSize,
                                      long firstBad, long tail) throws JSONException {
        result.put("ok", false);
        result.put("timelineReliable", false);
        result.put("verdict", verdict);
        result.put("packetSize", packetSize);
        result.put("firstBadOffset", firstBad);
        result.put("tailBytes", tail);
        result.put("durationUs", 0);
        result.put("segments", new JSONArray());
        return result;
    }

    private static void inspectPacket(byte[] packet, int at, int length, long packetOffset,
                                      Clock[] clocks, Clock[] ptsClocks,
                                      Clock[] dtsClocks, PesHeader[] pesHeaders,
                                      Timeline videoTimeline, Timeline pcrTimeline) {
        int pid = ((packet[at + 1] & 0x1f) << 8) | (packet[at + 2] & 0xff);
        int adaptation = (packet[at + 3] >> 4) & 0x03;
        int payloadAt = at + 4;
        if (adaptation == 2 || adaptation == 3) {
            if (payloadAt >= at + length) return;
            int adaptationLength = packet[payloadAt] & 0xff;
            payloadAt++;
            if (adaptationLength > 0 && payloadAt + adaptationLength <= at + length) {
                if (adaptationLength >= 7 && (packet[payloadAt] & 0x10) != 0) {
                    long raw = readPcrBase(packet, payloadAt + 1);
                    Clock clock = clocks[pid];
                    if (clock == null) {
                        clock = new Clock();
                        clocks[pid] = clock;
                    }
                    pcrTimeline.observe(clock.unwrap(raw), packetOffset);
                }
                payloadAt += adaptationLength;
            }
        }
        if (adaptation != 1 && adaptation != 3) return;
        if (payloadAt >= at + length) return;

        boolean start = (packet[at + 1] & 0x40) != 0;
        if (start) {
            int pointer = packet[payloadAt] & 0xff;
            payloadAt++;
            PesHeader header = pesHeaders[pid];
            if (header == null) {
                header = new PesHeader();
                pesHeaders[pid] = header;
            }
            header.reset(packetOffset);
            if (pointer > at + length - payloadAt) {
                header.active = false;
                return;
            }
            payloadAt += pointer;
        }
        PesHeader header = pesHeaders[pid];
        if (header == null || !header.active) return;
        header.append(packet, payloadAt, at + length - payloadAt);
        if (header.length < 9) return;

        byte[] pes = header.bytes;
        if ((pes[0] & 0xff) != 0 || (pes[1] & 0xff) != 0 || (pes[2] & 0xff) != 1) {
            header.active = false;
            return;
        }
        int headerLength = (pes[8] & 0xff) + 9;
        if (header.length < headerLength) return;
        header.active = false;
        int streamId = pes[3] & 0xff;
        if (streamId < 0xe0 || streamId > 0xef) return;
        int flags = (pes[7] >> 6) & 0x03;
        if (flags == 0 || headerLength < 14) return;
        Clock ptsClock = ptsClocks[pid];
        if (ptsClock == null) {
            ptsClock = new Clock();
            ptsClocks[pid] = ptsClock;
        }
        videoTimeline.observe(ptsClock.unwrap(readTimestamp(pes, 9)), header.startOffset);
        if (flags == 3 && headerLength >= 19) {
            Clock dtsClock = dtsClocks[pid];
            if (dtsClock == null) {
                dtsClock = new Clock();
                dtsClocks[pid] = dtsClock;
            }
            videoTimeline.observe(dtsClock.unwrap(readTimestamp(pes, 14)), header.startOffset);
        }
    }

    private static long readPcrBase(byte[] bytes, int at) {
        long value = ((long) (bytes[at] & 0xff)) << 25;
        value |= ((long) (bytes[at + 1] & 0xff)) << 17;
        value |= ((long) (bytes[at + 2] & 0xff)) << 9;
        value |= ((long) (bytes[at + 3] & 0xff)) << 1;
        value |= (bytes[at + 4] & 0x80) >>> 7;
        return value & (WRAP - 1);
    }

    private static long readTimestamp(byte[] bytes, int at) {
        long value = ((long) (bytes[at] & 0x0e)) << 29;
        value |= ((long) (bytes[at + 1] & 0xff)) << 22;
        value |= ((long) (bytes[at + 2] & 0xff)) << 14;
        value |= ((long) (bytes[at + 3] & 0xff)) << 6;
        value |= (bytes[at + 4] & 0xff) >> 1;
        return value & (WRAP - 1);
    }

    private static final class Clock {
        private boolean initialized;
        private long previousRaw;
        private long previousUnwrapped;

        long unwrap(long raw) {
            if (!initialized) {
                initialized = true;
                previousRaw = raw;
                previousUnwrapped = raw;
                return raw;
            }
            long delta = raw - previousRaw;
            long candidate = previousUnwrapped + delta;
            if (delta < -WRAP / 2) candidate += WRAP;
            else if (delta > WRAP / 2) candidate -= WRAP;
            previousRaw = raw;
            previousUnwrapped = candidate;
            return candidate;
        }
    }

    private static final class PesHeader {
        private static final int CAPACITY = 264;
        private final byte[] bytes = new byte[CAPACITY];
        private long startOffset;
        private int length;
        private boolean active;

        void reset(long startOffset) {
            this.startOffset = startOffset;
            length = 0;
            active = true;
        }

        void append(byte[] source, int from, int sourceLength) {
            int count = Math.min(sourceLength, CAPACITY - length);
            if (count <= 0) return;
            System.arraycopy(source, from, bytes, length, count);
            length += count;
        }
    }

    private static final class Region {
        private final long offset;
        private long minTimestamp;
        private long maxTimestamp;

        Region(long offset, long timestampUs) {
            this.offset = offset;
            minTimestamp = timestampUs;
            maxTimestamp = timestampUs;
        }
    }

    private static final class Timeline {
        private final java.util.List<Region> regions = new java.util.ArrayList<>();
        private long count;
        private boolean overflow;

        void observe(long timestampUs, long offset) {
            count++;
            if (regions.isEmpty()) {
                regions.add(new Region(offset, timestampUs));
                return;
            }
            Region current = regions.get(regions.size() - 1);
            if (timestampUs < current.maxTimestamp - DISCONTINUITY_GAP_TICKS) {
                if (regions.size() >= MAX_REGIONS) {
                    overflow = true;
                    return;
                }
                regions.add(new Region(offset, timestampUs));
                return;
            }
            current.minTimestamp = Math.min(current.minTimestamp, timestampUs);
            current.maxTimestamp = Math.max(current.maxTimestamp, timestampUs);
        }

        boolean hasPositiveDuration() {
            for (Region region : regions) {
                if (region.maxTimestamp > region.minTimestamp) return true;
            }
            return false;
        }
    }
}
