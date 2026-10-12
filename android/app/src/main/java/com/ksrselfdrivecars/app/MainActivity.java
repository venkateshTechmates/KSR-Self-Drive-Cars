package com.ksrselfdrivecars.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

/**
 * The KSR website in a native shell (see capacitor.config.ts and Docs/ANDROID.md).
 *
 * The site is not designed to draw under the system bars, so the web view is kept inside the
 * safe area: below the status bar and any camera cutout, above the navigation bar and the
 * on-screen keyboard. The bars show the brand's dark ink with light icons.
 */
public class MainActivity extends BridgeActivity {

    private static final int INK = Color.parseColor("#1D2125");

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Draw edge to edge on every Android version (Android 15+ enforces it), then pad below.
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
        super.onCreate(savedInstanceState);

        View webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null || !(webView.getParent() instanceof View)) return;
        View container = (View) webView.getParent();
        container.setBackgroundColor(INK);
        ViewCompat.setOnApplyWindowInsetsListener(container, (view, insets) -> {
            Insets safe = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime()
            );
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(container);
    }
}
