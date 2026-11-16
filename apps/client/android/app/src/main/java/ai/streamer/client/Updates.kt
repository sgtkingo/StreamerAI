package ai.streamer.client

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ExecutorService

/**
 * Self-update for sideloaded APKs (GitHub Releases). Checks the release
 * metadata at most once a day, asks before downloading, verifies size and
 * SHA-256 and hands the APK to the system installer, which asks the person
 * again and accepts it only when it is signed with this app's release key.
 */
class Updates(private val activity: Activity, private val worker: ExecutorService) {
    companion object {
        const val ACTION_INSTALL_RESULT = "ai.streamer.client.INSTALL_RESULT"
        private const val CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000
    }
    private data class Release(val version: String, val url: String, val filename: String, val bytes: Long, val sha256: String)
    private val preferences = activity.getSharedPreferences("streamerai-updates", Activity.MODE_PRIVATE)

    fun checkDaily(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - preferences.getLong("checkedAt", 0) < CHECK_INTERVAL_MS) return
        worker.execute {
            try {
                val release = latest() ?: return@execute
                preferences.edit().putLong("checkedAt", now).apply()
                if (!UpdatePolicy.isNewer(release.version, BuildConfig.VERSION_NAME)) return@execute
                if (!force && preferences.getString("skipped", null) == release.version && now - preferences.getLong("skippedAt", 0) < 3 * CHECK_INTERVAL_MS) return@execute
                activity.runOnUiThread { offer(release) }
            } catch (_: Exception) { /* offline or rate-limited: try again tomorrow */ }
        }
    }

    private fun latest(): Release? {
        val text = fetch(BuildConfig.UPDATE_MANIFEST_URL, 512 * 1024).toString(Charsets.UTF_8)
        val metadata = JSONObject(String(Base64.getDecoder().decode(JSONObject(text).getString("payload")), Charsets.UTF_8))
        if (metadata.optString("format") != "streamerai-signed-release/v1" || metadata.optString("channel") != "stable") return null
        val artifacts = metadata.getJSONArray("artifacts")
        for (index in 0 until artifacts.length()) {
            val item = artifacts.getJSONObject(index)
            if (item.optString("platform") != "android" || item.optString("component") != "client") continue
            val release = Release(metadata.getString("version"), item.getString("url"), item.getString("filename"), item.getLong("bytes"), item.getString("sha256"))
            return release.takeIf { UpdatePolicy.validArtifact(it.url, it.filename, it.bytes, it.sha256) }
        }
        return null
    }

    private fun offer(release: Release) {
        if (activity.isDestroyed) return
        AlertDialog.Builder(activity)
            .setTitle("StreamerAI ${release.version} is available")
            .setMessage("Download and install the update now? Your server, profiles and pairing stay as they are.")
            .setPositiveButton("Update") { _, _ -> download(release) }
            .setNegativeButton("Later") { _, _ -> preferences.edit().putString("skipped", release.version).putLong("skippedAt", System.currentTimeMillis()).apply() }
            .show()
    }

    private fun download(release: Release) {
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(activity)
                .setTitle("Allow app updates")
                .setMessage("Allow StreamerAI to install its own updates, then choose Update again.")
                .setPositiveButton("Open settings") { _, _ -> activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))) }
                .setNegativeButton("Cancel", null)
                .show()
            return
        }
        worker.execute {
            try {
                val directory = File(activity.cacheDir, "updates").apply { mkdirs() }
                directory.listFiles()?.forEach { it.delete() }
                val file = File(directory, release.filename)
                val bytes = fetch(release.url, release.bytes)
                val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                if (bytes.size.toLong() != release.bytes || digest != release.sha256) throw SecurityException("The update failed verification.")
                file.writeBytes(bytes)
                install(file)
            } catch (error: Exception) {
                activity.runOnUiThread { if (!activity.isDestroyed) AlertDialog.Builder(activity).setMessage("The update could not be downloaded. ${error.message ?: ""}").setPositiveButton("OK", null).show() }
            }
        }
    }

    private fun install(file: File) {
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(activity.packageName) }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("streamerai.apk", 0, file.length()).use { output -> file.inputStream().use { it.copyTo(output) }; session.fsync(output) }
            val result = Intent(activity, MainActivity::class.java).setAction(ACTION_INSTALL_RESULT)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getActivity(activity, sessionId, result, flags).intentSender)
        }
    }

    /** Called from MainActivity.onNewIntent with the installer's status. */
    fun handleInstallResult(intent: Intent): Boolean {
        if (intent.action != ACTION_INSTALL_RESULT) return false
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                confirm?.let { activity.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
            PackageInstaller.STATUS_SUCCESS -> Unit
            else -> AlertDialog.Builder(activity).setMessage("The update was not installed. ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""}").setPositiveButton("OK", null).show()
        }
        return true
    }

    private fun fetch(address: String, limit: Long): ByteArray {
        var url = URL(address)
        repeat(6) {
            val connection = (url.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false; connectTimeout = 15000; readTimeout = 60000
                setRequestProperty("User-Agent", "StreamerAI-Android/${BuildConfig.VERSION_NAME}")
            }
            try {
                val status = connection.responseCode
                if (status in 300..399) {
                    val next = URL(url, connection.getHeaderField("Location") ?: throw IllegalStateException("Redirect without location"))
                    // GitHub release downloads redirect to its asset CDN; stay on HTTPS GitHub hosts.
                    if (next.protocol != "https" || !(next.host == "github.com" || next.host.endsWith(".githubusercontent.com"))) throw SecurityException("Unexpected download host")
                    url = next; return@repeat
                }
                if (status != 200) throw IllegalStateException("HTTP $status")
                connection.inputStream.use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(64 * 1024); var total = 0L
                    while (true) { val read = input.read(buffer); if (read < 0) break; total += read; if (total > limit) throw SecurityException("Download too large"); output.write(buffer, 0, read) }
                    return output.toByteArray()
                }
            } finally { connection.disconnect() }
        }
        throw IllegalStateException("Too many redirects")
    }
}
