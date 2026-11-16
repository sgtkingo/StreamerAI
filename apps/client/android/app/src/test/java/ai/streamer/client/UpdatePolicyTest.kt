package ai.streamer.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePolicyTest {
    private val digest = "a".repeat(64)
    private val apk = "StreamerAI-Client-0.2.0-android.apk"
    private val url = "https://github.com/sgtkingo/StreamerAI/releases/download/v0.2.0/$apk"

    @Test fun versionsCompareNumerically() {
        assertTrue(UpdatePolicy.isNewer("0.10.0", "0.9.9"))
        assertTrue(UpdatePolicy.isNewer("1.0.0", "1.0.0-beta.1"))
        assertFalse(UpdatePolicy.isNewer("0.2.0", "0.2.0"))
        assertFalse(UpdatePolicy.isNewer("0.1.9", "0.2.0"))
        assertFalse(UpdatePolicy.isNewer("not-a-version", "0.2.0"))
        assertEquals(-1, UpdatePolicy.compare("1.0.0-alpha", "1.0.0-beta"))
    }

    @Test fun onlyRepositoryReleaseApksAreAccepted() {
        assertTrue(UpdatePolicy.validArtifact(url, apk, 8_000_000, digest))
        assertFalse(UpdatePolicy.validArtifact(url.replace("https", "http"), apk, 8_000_000, digest))
        assertFalse(UpdatePolicy.validArtifact("https://example.com/sgtkingo/StreamerAI/releases/download/v0.2.0/$apk", apk, 8_000_000, digest))
        assertFalse(UpdatePolicy.validArtifact("https://github.com/other/repo/releases/download/v0.2.0/$apk", apk, 8_000_000, digest))
        assertFalse(UpdatePolicy.validArtifact(url, "other.apk", 8_000_000, digest))
        assertFalse(UpdatePolicy.validArtifact(url, apk, 0, digest))
        assertFalse(UpdatePolicy.validArtifact(url, apk, 8_000_000, "zz"))
    }
}
