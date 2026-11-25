package com.qoder.cinema;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Surface;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.ColorInfo;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.OnInputFrameProcessedListener;
import androidx.media3.common.util.Clock;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.util.TimestampIterator;
import androidx.media3.decoder.DecoderInputBuffer;
import androidx.media3.transformer.AssetLoader;
import androidx.media3.transformer.Codec;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.DefaultMuxer;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.EditedMediaItemSequence;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExoPlayerAssetLoader;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.Muxer;
import androidx.media3.transformer.SampleConsumer;
import androidx.media3.transformer.Transformer;
import androidx.media3.transformer.TransformationRequest;

import com.google.common.collect.ImmutableList;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** P1-B：只做无损转封装可行性验证，任何解码、编码或回退都会使 PoC 失败。 */
@OptIn(markerClass = UnstableApi.class)
public final class TransformerTsProbe {
    static final long DEFAULT_TIMEOUT_MS = TimeUnit.MINUTES.toMillis(20);
    static final long MAX_TIMEOUT_MS = TimeUnit.MINUTES.toMillis(40);
    private static final long AV_SYNC_TOLERANCE_US = 50_000L;
    private static final long DURATION_TOLERANCE_US = 100_000L;

    private TransformerTsProbe() {}

    interface Callback {
        void onResult(JSONObject result);
    }

    public static void run(Context context, File input, File output, long timeoutMs, Callback callback) {
        Handler main = new Handler(Looper.getMainLooper());
        main.post(() -> new Session(context.getApplicationContext(), input, output, timeoutMs, main, callback).start());
    }

    private static final class Session {
        private final Context context;
        private final File input;
        private final File output;
        private final File part;
        private final long timeoutMs;
        private final Handler handler;
        private final Callback callback;
        private final long startedAt = SystemClock.elapsedRealtime();
        private final AtomicBoolean done = new AtomicBoolean();
        private final AtomicBoolean fallbackApplied = new AtomicBoolean();
        private final Map<Integer, Fingerprint> inputFingerprints = new ConcurrentHashMap<>();
        private final FingerprintingMuxer.Factory muxerFactory = new FingerprintingMuxer.Factory();
        private Transformer transformer;
        private Runnable timeoutTask;

        Session(Context context, File input, File output, long timeoutMs, Handler handler, Callback callback) {
            this.context = context;
            this.input = input;
            this.output = output;
            this.part = new File(output.getAbsolutePath() + ".part");
            this.timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1L, timeoutMs));
            this.handler = handler;
            this.callback = callback;
        }

        void start() {
            if (input == null || output == null || !input.isFile() || input.length() <= 0) {
                fail(MediaRemuxer.CODE_FILE_MISSING, "input-missing", null);
                return;
            }
            if (input.getAbsoluteFile().equals(output.getAbsoluteFile())) {
                fail(MediaRemuxer.CODE_INVALID_INPUT, "input-output-same", null);
                return;
            }
            if (output.exists() || part.exists()) {
                fail(MediaRemuxer.CODE_INVALID_INPUT, "output-or-part-exists", null);
                return;
            }

            try {
                Codec.DecoderFactory decoders = new Codec.DecoderFactory() {
                    @Override
                    public Codec createForAudioDecoding(Format format) throws ExportException {
                        throw forbidden("audio-decoding");
                    }

                    @Override
                    public Codec createForVideoDecoding(Format format, Surface surface, boolean sdr)
                            throws ExportException {
                        throw forbidden("video-decoding");
                    }
                };
                Codec.EncoderFactory encoders = new Codec.EncoderFactory() {
                    @Override
                    public Codec createForAudioEncoding(Format format) throws ExportException {
                        throw forbidden("audio-encoding");
                    }

                    @Override
                    public Codec createForVideoEncoding(Format format) throws ExportException {
                        throw forbidden("video-encoding");
                    }
                };
                AssetLoader.Factory assets = new FingerprintingAssetLoader.Factory(
                        new ExoPlayerAssetLoader.Factory(context, decoders, false, Clock.DEFAULT),
                        inputFingerprints);
                MediaItem mediaItem = MediaItem.fromUri(Uri.fromFile(input));
                EditedMediaItem edited = new EditedMediaItem.Builder(mediaItem)
                        .setRemoveAudio(false)
                        .setRemoveVideo(false)
                        .setEffects(Effects.EMPTY)
                        .build();
                Composition composition = new Composition.Builder(new EditedMediaItemSequence(edited))
                        .setEffects(Effects.EMPTY)
                        .build();

                transformer = new Transformer.Builder(context)
                        .setLooper(Looper.getMainLooper())
                        .setAssetLoaderFactory(assets)
                        .setEncoderFactory(encoders)
                        .setMuxerFactory(muxerFactory)
                        .addListener(new Transformer.Listener() {
                            @Override
                            public void onCompleted(Composition composition, ExportResult exportResult) {
                                Session.this.onCompleted(exportResult);
                            }

                            @Override
                            public void onError(Composition composition, ExportResult exportResult,
                                                ExportException exception) {
                                Session.this.onError(exception);
                            }

                            @Override
                            public void onFallbackApplied(Composition composition,
                                                          TransformationRequest original,
                                                          TransformationRequest fallback) {
                                fallbackApplied.set(true);
                            }
                        })
                        .build();

                timeoutTask = () -> {
                    if (!done.compareAndSet(false, true)) return;
                    try {
                        if (transformer != null) transformer.cancel();
                    } catch (Exception ignored) {
                    }
                    emitFailure(MediaRemuxer.CODE_TIMEOUT, "transformer-timeout", true, null);
                };
                handler.postDelayed(timeoutTask, timeoutMs);
                transformer.start(composition, part.getAbsolutePath());
            } catch (Exception e) {
                fail(MediaRemuxer.CODE_UNSUPPORTED, "transformer-start-failed", e);
            }
        }

        private void onCompleted(ExportResult exportResult) {
            if (!done.compareAndSet(false, true)) return;
            handler.removeCallbacks(timeoutTask);
            try {
                if (!part.isFile() || part.length() <= 0 || !part.renameTo(output)) {
                    emitFailure(MediaRemuxer.CODE_UNSUPPORTED, "output-publish-failed", true, null);
                    return;
                }
                JSONObject result = verify(exportResult);
                callback.onResult(result);
            } catch (Exception e) {
                emitFailure(MediaRemuxer.CODE_UNSUPPORTED, "verification-failed", false, e);
            }
        }

        private void onError(ExportException exception) {
            if (!done.compareAndSet(false, true)) return;
            handler.removeCallbacks(timeoutTask);
            emitFailure(MediaRemuxer.CODE_UNSUPPORTED, "transformer-error", true, exception);
        }

        private JSONObject verify(ExportResult exportResult) throws Exception {
            JSONObject result = baseResult();
            result.put("outputPublished", true);
            result.put("outputBytes", output.length());
            result.put("durationMs", exportResult.durationMs);
            result.put("videoFrameCount", exportResult.videoFrameCount);
            result.put("audioEncoderName", exportResult.audioEncoderName == null
                    ? JSONObject.NULL : exportResult.audioEncoderName);
            result.put("videoEncoderName", exportResult.videoEncoderName == null
                    ? JSONObject.NULL : exportResult.videoEncoderName);

            JSONArray processed = new JSONArray();
            boolean copyOnly = isEmpty(exportResult.audioEncoderName)
                    && isEmpty(exportResult.videoEncoderName) && !fallbackApplied.get();
            for (ExportResult.ProcessedInput item : exportResult.processedInputs) {
                JSONObject row = new JSONObject();
                row.put("audioDecoderName", item.audioDecoderName == null
                        ? JSONObject.NULL : item.audioDecoderName);
                row.put("videoDecoderName", item.videoDecoderName == null
                        ? JSONObject.NULL : item.videoDecoderName);
                processed.put(row);
                copyOnly = copyOnly && isEmpty(item.audioDecoderName) && isEmpty(item.videoDecoderName);
            }
            result.put("processedInputs", processed);
            result.put("copyOnly", copyOnly);
            result.put("fallbackApplied", fallbackApplied.get());

            JSONObject tracks = new JSONObject();
            boolean encodedSamplesPreserved = inputFingerprints.keySet().equals(muxerFactory.fingerprints.keySet());
            for (Map.Entry<Integer, Fingerprint> entry : inputFingerprints.entrySet()) {
                Fingerprint in = entry.getValue();
                Fingerprint out = muxerFactory.fingerprints.get(entry.getKey());
                boolean preserved = out != null && in.samePayloadAs(out);
                encodedSamplesPreserved = encodedSamplesPreserved && preserved;
                JSONObject evidence = new JSONObject();
                evidence.put("input", in.toJson());
                evidence.put("output", out == null ? JSONObject.NULL : out.toJson());
                evidence.put("preserved", preserved);
                tracks.put(trackName(entry.getKey()), evidence);
            }
            result.put("tracks", tracks);
            result.put("encodedSamplesPreserved", encodedSamplesPreserved);

            Fingerprint videoIn = inputFingerprints.get(C.TRACK_TYPE_VIDEO);
            Fingerprint videoOut = muxerFactory.fingerprints.get(C.TRACK_TYPE_VIDEO);
            boolean videoFrameCountMatches = videoIn != null && videoOut != null
                    && exportResult.videoFrameCount == videoIn.samples
                    && exportResult.videoFrameCount == videoOut.samples;
            result.put("videoFrameCountMatches", videoFrameCountMatches);

            long inputSpanUs = inputSpanUs();
            MediaRemuxer.ProbeReport report = MediaRemuxer.probeReport(output, inputSpanUs);
            String probeVerdict = report.verdict == null ? "pass" : report.verdict;
            result.put("probeVerdict", probeVerdict);
            result.put("expectedDurationUs", inputSpanUs);
            result.put("durationUs", report.durationUs);
            result.put("trackCount", report.trackCount);
            result.put("audioTrackCount", report.audioTrackCount);
            result.put("videoTrackIndex", report.videoTrackIndex);
            result.put("videoMime", report.videoMime == null ? JSONObject.NULL : report.videoMime);
            result.put("width", report.width);
            result.put("height", report.height);
            JSONArray seeks = new JSONArray();
            for (MediaRemuxer.ProbeSeek seek : report.seeks) {
                JSONObject point = new JSONObject();
                point.put("phase", seek.phase);
                point.put("requestedUs", seek.requestedUs);
                point.put("sampleUs", seek.sampleUs);
                point.put("deltaUs", seek.sampleUs < 0 ? -1L : seek.sampleUs - seek.requestedUs);
                point.put("sizeBytes", seek.sizeBytes);
                point.put("hit", seek.hit);
                seeks.put(point);
            }
            result.put("seekPoints", seeks);
            boolean durationMatches = exportResult.durationMs > 0
                    && Math.abs(report.durationUs - exportResult.durationMs * 1000L) <= DURATION_TOLERANCE_US;
            result.put("durationMatchesTransformer", durationMatches);

            JSONObject avSync = avSyncJson();
            result.put("avSync", avSync);
            boolean avSyncChecked = avSync.optBoolean("checked", false);
            boolean avSyncPreserved = avSync.optBoolean("preserved", false);

            long inputBSlices = videoIn == null ? 0L : videoIn.bSlices;
            long outputBSlices = videoOut == null ? 0L : videoOut.bSlices;
            boolean bSlicesPreserved = inputBSlices > 0 && inputBSlices == outputBSlices;
            JSONObject bSlices = new JSONObject();
            bSlices.put("input", inputBSlices);
            bSlices.put("output", outputBSlices);
            bSlices.put("presentInInput", inputBSlices > 0);
            bSlices.put("preserved", bSlicesPreserved);
            result.put("bSlices", bSlices);

            List<String> reasons = new ArrayList<>();
            if (!copyOnly) reasons.add("decode-encode-or-fallback-detected");
            if (!encodedSamplesPreserved) reasons.add("encoded-sample-fingerprint-mismatch");
            if (!videoFrameCountMatches) reasons.add("video-frame-count-mismatch");
            if (!"pass".equals(probeVerdict)) reasons.add("probe-" + probeVerdict);
            if (!durationMatches) reasons.add("duration-mismatch");
            if (!avSyncChecked) reasons.add("av-sync-not-checkable");
            else if (!avSyncPreserved) reasons.add("av-sync-changed");
            if (!bSlicesPreserved) reasons.add("b-slices-not-preserved");
            if (!input.isFile()) reasons.add("input-not-retained");

            boolean ok = reasons.isEmpty();
            result.put("ok", ok);
            result.put("success", ok);
            result.put("verdict", ok ? "pass" : "failed");
            result.put("code", ok ? "POC_PASS" : MediaRemuxer.CODE_UNSUPPORTED);
            result.put("reason", ok ? "lossless-copy-verified" : join(reasons));
            result.put("reasons", new JSONArray(reasons));
            AppLog.i(TAG, "transformer-poc verdict=" + result.optString("verdict")
                    + " copyOnly=" + copyOnly + " samples=" + encodedSamplesPreserved
                    + " probe=" + probeVerdict + " input=" + input.length()
                    + " output=" + output.length() + " elapsedMs=" + elapsedMs());
            return result;
        }

        private JSONObject avSyncJson() throws Exception {
            JSONObject result = new JSONObject();
            Fingerprint inAudio = inputFingerprints.get(C.TRACK_TYPE_AUDIO);
            Fingerprint inVideo = inputFingerprints.get(C.TRACK_TYPE_VIDEO);
            Fingerprint outAudio = muxerFactory.fingerprints.get(C.TRACK_TYPE_AUDIO);
            Fingerprint outVideo = muxerFactory.fingerprints.get(C.TRACK_TYPE_VIDEO);
            boolean checked = inAudio != null && inVideo != null && outAudio != null && outVideo != null
                    && inAudio.hasTimestamps() && inVideo.hasTimestamps()
                    && outAudio.hasTimestamps() && outVideo.hasTimestamps();
            result.put("checked", checked);
            if (!checked) {
                result.put("preserved", false);
                return result;
            }
            long inStart = inAudio.firstPtsUs - inVideo.firstPtsUs;
            long inEnd = inAudio.lastPtsUs - inVideo.lastPtsUs;
            long outStart = outAudio.firstPtsUs - outVideo.firstPtsUs;
            long outEnd = outAudio.lastPtsUs - outVideo.lastPtsUs;
            boolean preserved = Math.abs(inStart - outStart) <= AV_SYNC_TOLERANCE_US
                    && Math.abs(inEnd - outEnd) <= AV_SYNC_TOLERANCE_US;
            result.put("inputStartDeltaUs", inStart);
            result.put("inputEndDeltaUs", inEnd);
            result.put("outputStartDeltaUs", outStart);
            result.put("outputEndDeltaUs", outEnd);
            result.put("toleranceUs", AV_SYNC_TOLERANCE_US);
            result.put("preserved", preserved);
            return result;
        }

        private long inputSpanUs() {
            long first = C.TIME_UNSET;
            long last = C.TIME_UNSET;
            for (Fingerprint fingerprint : inputFingerprints.values()) {
                if (!fingerprint.hasTimestamps()) continue;
                if (first == C.TIME_UNSET || fingerprint.firstPtsUs < first) first = fingerprint.firstPtsUs;
                if (last == C.TIME_UNSET || fingerprint.lastPtsUs > last) last = fingerprint.lastPtsUs;
            }
            return first == C.TIME_UNSET || last == C.TIME_UNSET || last <= first ? 0L : last - first;
        }

        private void fail(String code, String reason, Exception error) {
            if (!done.compareAndSet(false, true)) return;
            emitFailure(code, reason, true, error);
        }

        private void emitFailure(String code, String reason, boolean cleanupPart, Exception error) {
            if (timeoutTask != null) handler.removeCallbacks(timeoutTask);
            if (cleanupPart) MediaRemuxer.deleteQuietly(part);
            try {
                JSONObject result = baseResult();
                result.put("ok", false);
                result.put("success", false);
                result.put("verdict", "failed");
                result.put("code", code);
                result.put("reason", reason);
                result.put("outputPublished", output.isFile());
                if (error != null) {
                    result.put("exception", error.getClass().getSimpleName() + ": " + error.getMessage());
                }
                callback.onResult(result);
            } catch (Exception ignored) {
            }
        }

        private JSONObject baseResult() throws Exception {
            JSONObject result = new JSONObject();
            result.put("engine", "Media3 Transformer 1.3.1");
            result.put("inputPath", input == null ? "" : input.getAbsolutePath());
            result.put("outputPath", output == null ? "" : output.getAbsolutePath());
            result.put("inputBytes", input == null ? 0L : input.length());
            result.put("outputBytes", output == null || !output.isFile() ? 0L : output.length());
            result.put("partBytes", part == null || !part.isFile() ? 0L : part.length());
            result.put("inputRetained", input != null && input.isFile());
            result.put("elapsedMs", elapsedMs());
            result.put("copyOnly", false);
            result.put("fallbackApplied", fallbackApplied.get());
            return result;
        }

        private long elapsedMs() {
            return SystemClock.elapsedRealtime() - startedAt;
        }
    }

    private static final String TAG = "TransformerTsProbe";

    private static ExportException forbidden(String operation) {
        int code = operation.endsWith("decoding")
                ? ExportException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED
                : ExportException.ERROR_CODE_ENCODING_FORMAT_UNSUPPORTED;
        return ExportException.createForAssetLoader(
                new IllegalStateException(operation + " is forbidden in lossless PoC"), code);
    }

    private static boolean isEmpty(String value) {
        return value == null || value.isEmpty();
    }

    private static String join(List<String> values) {
        StringBuilder result = new StringBuilder();
        for (String value : values) {
            if (result.length() > 0) result.append(',');
            result.append(value);
        }
        return result.toString();
    }

    private static String trackName(int trackType) {
        if (trackType == C.TRACK_TYPE_AUDIO) return "audio";
        if (trackType == C.TRACK_TYPE_VIDEO) return "video";
        return "track-" + trackType;
    }

    private static int trackTypeOf(String mime) {
        return mime != null && mime.startsWith("video/") ? C.TRACK_TYPE_VIDEO : C.TRACK_TYPE_AUDIO;
    }

    static final class Fingerprint {
        final String mime;
        final MessageDigest digest;
        long samples;
        long payloadBytes;
        long syncSamples;
        long bSlices;
        long firstPtsUs = C.TIME_UNSET;
        long lastPtsUs = C.TIME_UNSET;
        private String cachedSha256;

        Fingerprint(String mime) {
            this.mime = mime == null ? "" : mime;
            try {
                digest = MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException e) {
                throw new IllegalStateException(e);
            }
        }

        synchronized void add(ByteBuffer data, boolean keyFrame, long presentationTimeUs) {
            if (data == null || !data.hasRemaining()) return;
            cachedSha256 = null;
            ByteBuffer payload = data.duplicate();
            int length = payload.remaining();
            digest.update((byte) (length >>> 24));
            digest.update((byte) (length >>> 16));
            digest.update((byte) (length >>> 8));
            digest.update((byte) length);
            digest.update(payload);
            digest.update((byte) (keyFrame ? 1 : 0));
            if (samples == 0) firstPtsUs = presentationTimeUs;
            lastPtsUs = presentationTimeUs;
            samples += 1;
            payloadBytes += length;
            if (keyFrame) syncSamples += 1;
            if (C.TRACK_TYPE_VIDEO == trackTypeOf(mime)) {
                bSlices += countBFrames(data);
            }
        }

        synchronized boolean samePayloadAs(Fingerprint other) {
            return other != null && mime.equals(other.mime) && samples == other.samples
                    && payloadBytes == other.payloadBytes && syncSamples == other.syncSamples
                    && sha256().equals(other.sha256());
        }

        synchronized boolean hasTimestamps() {
            return samples > 0 && firstPtsUs != C.TIME_UNSET && lastPtsUs != C.TIME_UNSET;
        }

        synchronized String sha256() {
            if (cachedSha256 != null) return cachedSha256;
            byte[] hash = digest.digest();
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte value : hash) hex.append(String.format(Locale.US, "%02x", value & 0xff));
            cachedSha256 = hex.toString();
            return cachedSha256;
        }

        synchronized JSONObject toJson() throws Exception {
            JSONObject result = new JSONObject();
            result.put("mime", mime);
            result.put("samples", samples);
            result.put("payloadBytes", payloadBytes);
            result.put("syncSamples", syncSamples);
            result.put("bSlices", bSlices);
            result.put("firstPtsUs", firstPtsUs);
            result.put("lastPtsUs", lastPtsUs);
            result.put("sha256", sha256());
            return result;
        }
    }

    private static final class FingerprintingAssetLoader {
        private static final class Factory implements AssetLoader.Factory {
            private final AssetLoader.Factory delegate;
            private final Map<Integer, Fingerprint> fingerprints;

            Factory(AssetLoader.Factory delegate, Map<Integer, Fingerprint> fingerprints) {
                this.delegate = delegate;
                this.fingerprints = fingerprints;
            }

            @Override
            public AssetLoader createAssetLoader(EditedMediaItem item, Looper looper, AssetLoader.Listener listener) {
                return delegate.createAssetLoader(item, looper, new AssetLoader.Listener() {
                    @Override
                    public void onDurationUs(long durationUs) {
                        listener.onDurationUs(durationUs);
                    }

                    @Override
                    public void onTrackCount(int trackCount) {
                        listener.onTrackCount(trackCount);
                    }

                    @Override
                    public boolean onTrackAdded(Format inputFormat, int supportedOutputTypes) {
                        boolean needsDecoding = listener.onTrackAdded(inputFormat, supportedOutputTypes);
                        if (!needsDecoding) {
                            fingerprints.computeIfAbsent(trackTypeOf(inputFormat.sampleMimeType),
                                    ignored -> new Fingerprint(inputFormat.sampleMimeType));
                        }
                        return needsDecoding;
                    }

                    @Override
                    public SampleConsumer onOutputFormat(Format format) throws ExportException {
                        SampleConsumer consumer = listener.onOutputFormat(format);
                        Fingerprint fingerprint = fingerprints.get(trackTypeOf(format.sampleMimeType));
                        return consumer == null || fingerprint == null ? consumer : new HashingSampleConsumer(consumer, fingerprint);
                    }

                    @Override
                    public void onError(ExportException exportException) {
                        listener.onError(exportException);
                    }
                });
            }
        }
    }

    private static final class HashingSampleConsumer implements SampleConsumer {
        private final SampleConsumer delegate;
        private final Fingerprint fingerprint;

        HashingSampleConsumer(SampleConsumer delegate, Fingerprint fingerprint) {
            this.delegate = delegate;
            this.fingerprint = fingerprint;
        }

        @Override
        public DecoderInputBuffer getInputBuffer() {
            return delegate.getInputBuffer();
        }

        @Override
        public boolean queueInputBuffer() {
            DecoderInputBuffer input = delegate.getInputBuffer();
            // 必须在交出缓冲区所有权前哈希，否则 muxer 线程可能已回收并清空它。
            if (input != null && !input.isEndOfStream()) {
                fingerprint.add(input.data, input.isKeyFrame(), input.timeUs);
            }
            return delegate.queueInputBuffer();
        }

        @Override
        public int queueInputBitmap(Bitmap bitmap, TimestampIterator timestamps) {
            return delegate.queueInputBitmap(bitmap, timestamps);
        }

        @Override
        public void setOnInputFrameProcessedListener(OnInputFrameProcessedListener listener) {
            delegate.setOnInputFrameProcessedListener(listener);
        }

        @Override
        public int queueInputTexture(int texId, long presentationTimeUs) {
            return delegate.queueInputTexture(texId, presentationTimeUs);
        }

        @Override
        public Surface getInputSurface() {
            return delegate.getInputSurface();
        }

        @Override
        public ColorInfo getExpectedInputColorInfo() {
            return delegate.getExpectedInputColorInfo();
        }

        @Override
        public int getPendingVideoFrameCount() {
            return delegate.getPendingVideoFrameCount();
        }

        @Override
        public boolean registerVideoFrame(long presentationTimeUs) {
            return delegate.registerVideoFrame(presentationTimeUs);
        }

        @Override
        public void signalEndOfVideoInput() {
            delegate.signalEndOfVideoInput();
        }
    }

    private static final class FingerprintingMuxer {
        private static final class Factory implements Muxer.Factory {
            final Map<Integer, Fingerprint> fingerprints = new ConcurrentHashMap<>();
            private final Muxer.Factory delegate = new DefaultMuxer.Factory();

            @Override
            public Muxer create(String path) throws Muxer.MuxerException {
                return new HashingMuxer(delegate.create(path), fingerprints);
            }

            @Override
            public ImmutableList<String> getSupportedSampleMimeTypes(int trackType) {
                return delegate.getSupportedSampleMimeTypes(trackType);
            }
        }

        private static final class HashingMuxer implements Muxer {
            private final Muxer delegate;
            private final Map<Integer, Fingerprint> fingerprints;
            private final Map<Integer, Integer> trackTypes = new ConcurrentHashMap<>();

            HashingMuxer(Muxer delegate, Map<Integer, Fingerprint> fingerprints) {
                this.delegate = delegate;
                this.fingerprints = fingerprints;
            }

            @Override
            public int addTrack(Format format) throws Muxer.MuxerException {
                int index = delegate.addTrack(format);
                int trackType = trackTypeOf(format.sampleMimeType);
                trackTypes.put(index, trackType);
                fingerprints.put(trackType, new Fingerprint(format.sampleMimeType));
                return index;
            }

            @Override
            public void writeSampleData(int trackIndex, ByteBuffer data, long presentationTimeUs, int flags)
                    throws Muxer.MuxerException {
                Integer trackType = trackTypes.get(trackIndex);
                Fingerprint fingerprint = trackType == null ? null : fingerprints.get(trackType);
                if (fingerprint != null) {
                    fingerprint.add(data, (flags & C.BUFFER_FLAG_KEY_FRAME) != 0, presentationTimeUs);
                }
                delegate.writeSampleData(trackIndex, data, presentationTimeUs, flags);
            }

            @Override
            public void addMetadata(androidx.media3.common.Metadata metadata) {
                delegate.addMetadata(metadata);
            }

            @Override
            public void release(boolean forCancellation) throws Muxer.MuxerException {
                delegate.release(forCancellation);
            }

            @Override
            public long getMaxDelayBetweenSamplesMs() {
                return delegate.getMaxDelayBetweenSamplesMs();
            }
        }
    }

    static int countBFrames(ByteBuffer sample) {
        if (sample == null || sample.remaining() < 2) return 0;
        ByteBuffer buffer = sample.duplicate();
        if (isAnnexB(buffer)) return countAnnexB(buffer);
        return countAvcc(buffer);
    }

    private static boolean isAnnexB(ByteBuffer buffer) {
        for (int i = buffer.position(); i + 3 < buffer.limit(); i++) {
            if (buffer.get(i) == 0 && buffer.get(i + 1) == 0) {
                if (buffer.get(i + 2) == 1) return true;
                if (buffer.get(i + 2) == 0 && buffer.get(i + 3) == 1) return true;
            }
        }
        return false;
    }

    private static int countAnnexB(ByteBuffer buffer) {
        List<Integer> starts = new ArrayList<>();
        for (int i = buffer.position(); i + 3 < buffer.limit(); i++) {
            if (buffer.get(i) == 0 && buffer.get(i + 1) == 0 && buffer.get(i + 2) == 1) {
                starts.add(i);
                i += 2;
            } else if (buffer.get(i) == 0 && buffer.get(i + 1) == 0
                    && buffer.get(i + 2) == 0 && buffer.get(i + 3) == 1) {
                starts.add(i);
                i += 3;
            }
        }
        int count = 0;
        for (int i = 0; i < starts.size(); i++) {
            int codePosition = starts.get(i);
            int codeLength = buffer.get(codePosition + 2) == 1 ? 3 : 4;
            int end = i + 1 < starts.size() ? starts.get(i + 1) : buffer.limit();
            if (isBSlice(buffer, codePosition + codeLength, end)) count += 1;
        }
        return count;
    }

    private static int countAvcc(ByteBuffer buffer) {
        int count = 0;
        int position = buffer.position();
        while (position + 4 <= buffer.limit()) {
            int lengthSize = avccLengthSize(buffer, position);
            if (lengthSize <= 0 || position + lengthSize > buffer.limit()) break;
            long length = 0;
            for (int i = 0; i < lengthSize; i++) {
                length = (length << 8) | (buffer.get(position + i) & 0xffL);
            }
            if (length <= 0 || length > buffer.limit() - position - lengthSize) break;
            int start = position + lengthSize;
            int end = start + (int) length;
            if (isBSlice(buffer, start, end)) count += 1;
            position = end;
        }
        return count;
    }

    private static int avccLengthSize(ByteBuffer buffer, int position) {
        int b0 = buffer.get(position) & 0xff;
        int b1 = buffer.get(position + 1) & 0xff;
        int b2 = buffer.get(position + 2) & 0xff;
        int b3 = buffer.get(position + 3) & 0xff;
        if (b0 == 0 && b1 == 0 && b2 == 0 && b3 >= 1 && b3 <= 4) return 4;
        if (b0 == 0 && b1 == 0 && b2 >= 1) return 3;
        if (b0 == 0 && b1 >= 1) return 2;
        return b0 >= 1 ? 1 : 0;
    }

    private static boolean isBSlice(ByteBuffer buffer, int start, int end) {
        if (start < 0 || end <= start || end > buffer.limit()) return false;
        ByteBuffer nal = buffer.duplicate();
        nal.position(start);
        nal.limit(end);
        int type = nal.get(start) & 0x1f;
        if (type != 1 && type != 5) return false;

        byte[] escaped = new byte[nal.remaining() - 1];
        int output = 0;
        int zeros = 0;
        for (int i = start + 1; i < end; i++) {
            int value = buffer.get(i) & 0xff;
            if (value == 3 && zeros >= 2 && i + 1 < end && (buffer.get(i + 1) & 0xff) <= 3) {
                zeros = 0;
                continue;
            }
            escaped[output++] = (byte) value;
            zeros = value == 0 ? zeros + 1 : 0;
        }
        if (output == 0) return false;
        BitReader reader = new BitReader(escaped, output);
        long firstMb = reader.readUnsignedExpGolomb();
        long sliceType = reader.readUnsignedExpGolomb();
        return firstMb >= 0 && (sliceType == 1 || sliceType == 6);
    }

    private static final class BitReader {
        private final byte[] data;
        private final int bitLength;
        private int offset;

        BitReader(byte[] data, int length) {
            this.data = data;
            this.bitLength = length * 8;
        }

        long readUnsignedExpGolomb() {
            int leading = 0;
            while (offset < bitLength && readBit() == 0) {
                leading += 1;
                if (leading > 31) return -1;
            }
            if (offset >= bitLength || leading > 31) return -1;
            long value = (1L << leading) - 1;
            if (leading > 0) value += readBits(leading);
            return value;
        }

        private int readBit() {
            if (offset >= bitLength) return 0;
            int value = (data[offset / 8] >> (7 - offset % 8)) & 1;
            offset += 1;
            return value;
        }

        private long readBits(int count) {
            long value = 0;
            for (int i = 0; i < count; i++) value = (value << 1) | readBit();
            return value;
        }
    }
}
