package com.qoder.cinema;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import java.nio.ByteBuffer;

import org.junit.Test;

public class TransformerTsProbeTest {
    @Test
    public void countsAnnexBBeforeLengthPrefixedRepresentation() {
        ByteBuffer annexB = ByteBuffer.wrap(new byte[] {
                0, 0, 0, 1, 0x41, (byte) 0xC0,
                0, 0, 1, 0x41, (byte) 0xA0,
        });
        ByteBuffer avcc = ByteBuffer.wrap(new byte[] {
                0, 0, 0, 2, 0x41, (byte) 0xC0,
                0, 0, 0, 2, 0x41, (byte) 0xA0,
        });

        assertEquals(1, TransformerTsProbe.countBFrames(annexB));
        assertEquals(1, TransformerTsProbe.countBFrames(avcc));
    }

    @Test
    public void ignoresNonVideoNalsAndPOnlySlices() {
        ByteBuffer sample = ByteBuffer.wrap(new byte[] {
                0, 0, 0, 1, 0x06, 0x05,
                0, 0, 1, 0x41, (byte) 0xC0,
        });

        assertEquals(0, TransformerTsProbe.countBFrames(sample));
    }

    @Test
    public void fingerprintHashRemainsStableAcrossEvidenceReads() {
        TransformerTsProbe.Fingerprint fingerprint = new TransformerTsProbe.Fingerprint("video/avc");
        fingerprint.add(ByteBuffer.wrap(new byte[] {1, 2, 3}), true, 0);

        String firstHash = fingerprint.sha256();
        assertEquals(firstHash, fingerprint.sha256());

        fingerprint.add(ByteBuffer.wrap(new byte[] {4, 5}), false, 1000);
        String updatedHash = fingerprint.sha256();
        assertNotEquals(firstHash, updatedHash);
        assertEquals(updatedHash, fingerprint.sha256());
    }
}
