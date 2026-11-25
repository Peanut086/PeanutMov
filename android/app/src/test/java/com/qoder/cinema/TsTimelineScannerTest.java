package com.qoder.cinema;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.file.Files;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class TsTimelineScannerTest {
    private static final int TS_SIZE = 188;
    private static final long WRAP = 1L << 33;

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void readsDurationFromVideoPtsAndDts() throws Exception {
        JSONObject result = scan(packet(videoPes(0, 0)), packet(videoPes(2, 1)));

        assertTrue(result.toString(), result.getBoolean("ok"));
        assertEquals("video-pts", result.getString("timelineSource"));
        assertEquals(2_000_000L, result.getLong("durationUs"));
        assertEquals(4L, result.getLong("timestampCount"));
        assertEquals(1, result.getJSONArray("segments").length());
        assertEquals(0L, result.getJSONArray("segments").getJSONObject(0).getLong("offset"));
        assertEquals(2_000_000L, result.getJSONArray("segments").getJSONObject(0).getLong("durationUs"));
    }

    @Test
    public void keepsSmallBFrameReorderingInOneRegion() throws Exception {
        JSONObject result = scan(
            packet(videoPes(0.08, 0)),
            packet(videoPes(0.24, 0.08)),
            packet(videoPes(0.16, 0.16))
        );

        assertTrue(result.toString(), result.getBoolean("ok"));
        assertEquals(240_000L, result.getLong("durationUs"));
        assertEquals(1, result.getJSONArray("segments").length());
    }

    @Test
    public void splitsTimestampResetIntoDiscontinuity() throws Exception {
        JSONObject result = scan(
            packet(videoPes(8, 9)),
            packet(videoPes(10, 9)),
            packet(videoPes(1, 0)),
            packet(videoPes(3, 2))
        );

        assertTrue(result.toString(), result.getBoolean("ok"));
        assertEquals(5_000_000L, result.getLong("durationUs"));
        assertEquals(1, result.getInt("discontinuities"));
        assertEquals(2, result.getJSONArray("segments").length());
        assertEquals(2_000_000L, result.getJSONArray("segments").getJSONObject(0).getLong("durationUs"));
        assertEquals(2L * TS_SIZE, result.getJSONArray("segments").getJSONObject(1).getLong("offset"));
        assertEquals(3_000_000L, result.getJSONArray("segments").getJSONObject(1).getLong("durationUs"));
        assertTrue(result.getJSONArray("segments").getJSONObject(1).getBoolean("discontinuity"));
    }

    @Test
    public void unwrapsPcrAcross33BitRollover() throws Exception {
        JSONObject result = scan(
            pcrPacket(WRAP - 45_000),
            pcrPacket(45_000)
        );

        assertTrue(result.toString(), result.getBoolean("ok"));
        assertEquals("pcr", result.getString("timelineSource"));
        assertEquals(1_000_000L, result.getLong("durationUs"));
    }

    @Test
    public void usesPcrWhenVideoTimelineHasNoSpan() throws Exception {
        JSONObject result = scan(
            packet(videoPes(1, 1)),
            pcrPacket(0),
            pcrPacket(180_000)
        );

        assertTrue(result.toString(), result.getBoolean("ok"));
        assertEquals("pcr", result.getString("timelineSource"));
        assertEquals(2_000_000L, result.getLong("durationUs"));
        assertEquals(2L, result.getLong("timestampCount"));
    }

    @Test
    public void rejectsFilePrefixInsteadOfInventingOffset() throws Exception {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        data.write(new byte[8]);
        data.write(packet(videoPes(0, 0)));
        data.write(packet(videoPes(2, 1)));

        JSONObject result = scan(data.toByteArray());

        assertFalse(result.getBoolean("timelineReliable"));
        assertEquals("prefix", result.getString("verdict"));
        assertEquals(8L, result.getLong("alignedStart"));
    }

    @Test
    public void rejectsTruncatedTail() throws Exception {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        data.write(packet(videoPes(0, 0)));
        data.write(packet(videoPes(2, 1)));
        data.write(new byte[7]);

        JSONObject result = scan(data.toByteArray());

        assertFalse(result.getBoolean("ok"));
        assertEquals("truncated", result.getString("verdict"));
        assertEquals(7L, result.getLong("tailBytes"));
    }

    @Test
    public void rejectsPacketSyncCorruption() throws Exception {
        byte[] first = packet(videoPes(0, 0));
        byte[] second = packet(videoPes(2, 1));
        second[0] = 0;

        JSONObject result = scan(first, second, nullPacket(), nullPacket(), nullPacket());

        assertFalse(result.getBoolean("ok"));
        assertEquals("corrupt", result.getString("verdict"));
        assertEquals(1L, result.getLong("badPackets"));
        assertEquals((long) TS_SIZE, result.getLong("firstBadOffset"));
    }

    @Test
    public void rejectsTsWithoutTimestampTimeline() throws Exception {
        byte[] first = new byte[TS_SIZE];
        first[0] = 0x47;
        first[1] = 0x1f;
        first[2] = (byte) 0xff;
        first[3] = 0x10;

        JSONObject result = scan(first, first.clone());

        assertFalse(result.getBoolean("timelineReliable"));
        assertEquals("no-timeline", result.getString("verdict"));
        assertEquals(0L, result.getLong("durationUs"));
    }

    @Test
    public void rejectsTimestampStormInsteadOfGrowingRegionsWithoutBound() throws Exception {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        for (int i = 0; i < 10_001; i++) {
            double seconds = 20_000 - 2L * i;
            data.write(packet(videoPes(seconds, seconds)));
        }
        File file = temporaryFolder.newFile();
        Files.write(file.toPath(), data.toByteArray());

        JSONObject result = TsTimelineScanner.scan(file);

        assertFalse(result.getBoolean("timelineReliable"));
        assertEquals("no-timeline", result.getString("verdict"));
        assertTrue(result.toString(), result.getJSONArray("segments").length() <= 10_000);
    }

    @Test
    public void supports192BytePacketsWithFourBytePrefix() throws Exception {
        JSONObject result = scan(widePacket(videoPes(0, 0)), widePacket(videoPes(2, 1)));

        assertTrue(result.toString(), result.getBoolean("ok"));
        assertEquals(192, result.getInt("packetSize"));
        assertEquals(2_000_000L, result.getLong("durationUs"));
        assertEquals(2L, result.getLong("totalPackets"));
    }

    private JSONObject scan(byte[]... packets) throws Exception {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        for (byte[] packet : packets) data.write(packet);
        File file = temporaryFolder.newFile();
        Files.write(file.toPath(), data.toByteArray());
        return TsTimelineScanner.scan(file);
    }

    private static byte[] nullPacket() {
        byte[] packet = new byte[TS_SIZE];
        packet[0] = 0x47;
        packet[1] = 0x1f;
        packet[2] = (byte) 0xff;
        packet[3] = 0x10;
        return packet;
    }

    private static byte[] packet(byte[] pes) {
        byte[] packet = new byte[TS_SIZE];
        packet[0] = 0x47;
        packet[1] = 0x41;
        packet[2] = 0;
        packet[3] = 0x10;
        packet[4] = 0;
        System.arraycopy(pes, 0, packet, 5, pes.length);
        for (int i = 5 + pes.length; i < packet.length; i++) packet[i] = (byte) 0xff;
        return packet;
    }

    private static byte[] widePacket(byte[] pes) {
        byte[] packet = new byte[192];
        byte[] narrow = packet(pes);
        System.arraycopy(narrow, 0, packet, 4, narrow.length);
        return packet;
    }

    private static byte[] videoPes(double ptsSec, double dtsSec) {
        long pts = Math.round(ptsSec * 90_000);
        long dts = Math.round(dtsSec * 90_000);
        ByteArrayOutputStream pes = new ByteArrayOutputStream();
        pes.write(0);
        pes.write(0);
        pes.write(1);
        pes.write(0xe0);
        pes.write(0);
        pes.write(14);
        pes.write(0x80);
        pes.write(0xc0);
        pes.write(10);
        writeTimestamp(pes, pts, true);
        writeTimestamp(pes, dts, false);
        pes.write(0);
        return pes.toByteArray();
    }

    private static byte[] pcrPacket(long base) {
        byte[] packet = new byte[TS_SIZE];
        packet[0] = 0x47;
        packet[1] = 1;
        packet[2] = 0;
        packet[3] = 0x30;
        packet[4] = 9;
        packet[5] = 0x10;
        packet[6] = (byte) (base >>> 25);
        packet[7] = (byte) (base >>> 17);
        packet[8] = (byte) (base >>> 9);
        packet[9] = (byte) (base >>> 1);
        packet[10] = (byte) (((base & 1) << 7) | 0x7e);
        packet[11] = 0;
        return packet;
    }

    private static void writeTimestamp(ByteArrayOutputStream output, long value, boolean pts) {
        output.write((int) (((value >>> 29) & 0x0e) | (pts ? 0x21 : 0x11)));
        output.write((int) (value >>> 22));
        output.write((int) (value >>> 14));
        output.write((int) (value >>> 6));
        output.write((int) (((value & 0x3f) << 1) | 1));
    }
}
