package com.scribe.dictation;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ScribeBgPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
