package ai.streamer.client

import java.net.URI

/** Pure update rules, kept free of Android classes so they run in JVM unit tests. */
object UpdatePolicy {
    private val version = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?$")
    private val apkName = Regex("^StreamerAI-Client-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?-android\\.apk$")
    private val sha256 = Regex("^[a-f0-9]{64}$")

    /** Numeric MAJOR.MINOR.PATCH ordering; a prerelease sorts before its release. */
    fun compare(left: String, right: String): Int {
        val a = version.matchEntire(left) ?: throw IllegalArgumentException("Invalid version")
        val b = version.matchEntire(right) ?: throw IllegalArgumentException("Invalid version")
        for (index in 1..3) {
            val difference = a.groupValues[index].toLong().compareTo(b.groupValues[index].toLong())
            if (difference != 0) return difference
        }
        val pa = a.groupValues[4]; val pb = b.groupValues[4]
        return when { pa == pb -> 0; pa.isEmpty() -> 1; pb.isEmpty() -> -1; else -> pa.compareTo(pb).coerceIn(-1, 1) }
    }

    fun isNewer(candidate: String, installed: String) = try { compare(candidate, installed) > 0 } catch (_: IllegalArgumentException) { false }

    /**
     * Only release assets of this repository are downloaded. Android itself
     * refuses an update that is not signed with the installed app's key.
     */
    fun validArtifact(url: String, filename: String, bytes: Long, digest: String): Boolean {
        val parsed = try { URI(url) } catch (_: Exception) { return false }
        return parsed.scheme == "https" && parsed.host == "github.com" && parsed.userInfo == null &&
            parsed.path.startsWith("/sgtkingo/StreamerAI/releases/download/") && parsed.path.endsWith("/$filename") &&
            apkName.matches(filename) && bytes in 1..(512L * 1024 * 1024) && sha256.matches(digest)
    }
}
