package com.scribe.dictation;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.content.ContextCompat;

// Keeps Scribe alive while it records or transcribes with the screen off or the
// app in the background. Android requires the notification this shows.
public class BgService extends Service {
    private static final String CHANNEL = "scribe_bg";
    private static final int NOTE_ID = 7;
    private static boolean running = false;
    private PowerManager.WakeLock wakeLock;

    static Notification build(Context c, String text) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Scribe background work", NotificationManager.IMPORTANCE_LOW));
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(c, CHANNEL)
                : new Notification.Builder(c);
        b.setContentTitle("Scribe")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true);
        Intent open = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (open != null) {
            b.setContentIntent(PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        return b.build();
    }

    static void start(Context c, String text, boolean mic) {
        try {
            Intent i = new Intent(c, BgService.class);
            i.putExtra("text", text);
            i.putExtra("mic", mic);
            ContextCompat.startForegroundService(c, i);
        } catch (Exception e) {
            // Android refused to start it (for example from the background).
        }
    }

    static void update(Context c, String text) {
        if (!running) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTE_ID, build(c, text));
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, BgService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null ? intent.getStringExtra("text") : null;
        boolean mic = intent != null && intent.getBooleanExtra("mic", false);
        if (text == null) text = "Scribe is working";
        Notification n = build(this, text);
        if (Build.VERSION.SDK_INT >= 30) {
            int type = mic ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            startForeground(NOTE_ID, n, type);
        } else {
            startForeground(NOTE_ID, n);
        }
        running = true;
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "scribe:bg");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire(6 * 60 * 60 * 1000L);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
