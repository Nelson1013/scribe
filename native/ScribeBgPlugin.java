package com.scribe.dictation;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;

// Records audio natively (so it keeps going with the screen off) and controls
// the background service that keeps Scribe alive.
@CapacitorPlugin(
    name = "ScribeBg",
    permissions = { @Permission(alias = "mic", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class ScribeBgPlugin extends Plugin {
    private MediaRecorder rec;
    private File file;
    private long startedAt;

    private void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(getContext(), "android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED
                && getActivity() != null) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { "android.permission.POST_NOTIFICATIONS" }, 4401);
        }
    }

    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        if (getPermissionState("mic") == PermissionState.GRANTED) {
            JSObject o = new JSObject();
            o.put("mic", true);
            call.resolve(o);
            askNotifications();
        } else {
            requestPermissionForAlias("mic", call, "micCallback");
        }
    }

    @PermissionCallback
    private void micCallback(PluginCall call) {
        JSObject o = new JSObject();
        boolean ok = getPermissionState("mic") == PermissionState.GRANTED;
        o.put("mic", ok);
        call.resolve(o);
        if (ok) askNotifications();
    }

    @PluginMethod
    public void startRecording(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            call.reject("Microphone permission is needed.");
            return;
        }
        try {
            BgService.start(getContext(), "Scribe is recording", true);
            file = new File(getContext().getFilesDir(), "rec-" + System.currentTimeMillis() + ".m4a");
            rec = new MediaRecorder();
            rec.setAudioSource(MediaRecorder.AudioSource.MIC);
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            rec.setAudioChannels(1);
            rec.setAudioSamplingRate(16000);
            rec.setAudioEncodingBitRate(48000);
            rec.setOutputFile(file.getAbsolutePath());
            rec.prepare();
            rec.start();
            startedAt = System.currentTimeMillis();
            JSObject o = new JSObject();
            o.put("path", file.getAbsolutePath());
            call.resolve(o);
        } catch (Exception e) {
            if (rec != null) {
                try { rec.release(); } catch (Exception ignored) { }
                rec = null;
            }
            BgService.stop(getContext());
            call.reject("Could not start recording: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        if (rec == null || file == null) {
            call.reject("Not recording.");
            return;
        }
        String path = file.getAbsolutePath();
        double secs = (System.currentTimeMillis() - startedAt) / 1000.0;
        try { rec.stop(); } catch (RuntimeException ignored) { }
        try { rec.release(); } catch (Exception ignored) { }
        rec = null;
        JSObject o = new JSObject();
        o.put("path", path);
        o.put("secs", secs);
        call.resolve(o);
    }

    @PluginMethod
    public void level(PluginCall call) {
        int amp = 0;
        try { if (rec != null) amp = rec.getMaxAmplitude(); } catch (Exception ignored) { }
        JSObject o = new JSObject();
        o.put("peak", amp / 32768.0);
        call.resolve(o);
    }

    @PluginMethod
    public void keepAlive(PluginCall call) {
        String text = call.getString("text", "Scribe is working");
        Boolean mic = call.getBoolean("mic", false);
        BgService.start(getContext(), text, mic != null && mic);
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        BgService.update(getContext(), call.getString("text", "Scribe is working"));
        call.resolve();
    }

    @PluginMethod
    public void release(PluginCall call) {
        if (rec == null) BgService.stop(getContext());
        call.resolve();
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String path = call.getString("path");
        if (path != null && path.startsWith(getContext().getFilesDir().getAbsolutePath())) {
            //noinspection ResultOfMethodCallIgnored
            new File(path).delete();
        }
        call.resolve();
    }

    @PluginMethod
    public void batterySettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception ignored) { }
        call.resolve();
    }
}
