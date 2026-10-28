#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <dispatcherqueue.h>
#include <winrt/base.h>
#include <winrt/Windows.Graphics.Effects.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.h>
#include <winrt/Windows.UI.Composition.h>
#include <winrt/Windows.UI.Composition.Desktop.h>
#include <windows.ui.composition.interop.h>
#include <initguid.h>
#include <wrl.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <unordered_map>
#include "microsoft.ui.composition.effects_impl.h"

using Compositor = winrt::Windows::UI::Composition::Compositor;
using DesktopTarget = winrt::Windows::UI::Composition::Desktop::DesktopWindowTarget;
using DispatcherController = winrt::Windows::System::DispatcherQueueController;
using EffectSourceParameter = winrt::Windows::UI::Composition::CompositionEffectSourceParameter;
using CompositionEffect = winrt::Windows::Graphics::Effects::IGraphicsEffect;
using ContainerVisual = winrt::Windows::UI::Composition::ContainerVisual;
using SpriteVisual = winrt::Windows::UI::Composition::SpriteVisual;
using Color = winrt::Windows::UI::Color;

namespace {
struct WindowBackdrop {
    DesktopTarget target{ nullptr };
    ContainerVisual root{ nullptr };
    SpriteVisual blur{ nullptr };
    SpriteVisual tint{ nullptr };
    SpriteVisual luminosity{ nullptr };
};
struct CaptionDragRegion {
    int height;
    int rightExclusion;
};

DispatcherController dispatcher{ nullptr };
Compositor compositor{ nullptr };
std::unordered_map<HWND, WindowBackdrop> windows;
std::unordered_map<HWND, CaptionDragRegion> captionDragRegions;

constexpr UINT_PTR kCaptionDragSubclassId = 0xADA2026;

LRESULT CALLBACK CaptionDragSubclass(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam,
    UINT_PTR subclassId, DWORD_PTR)
{
    // Let DWM process any native caption-button behavior first. This is the
    // documented path for custom frames and lets Windows own Snap Layouts.
    if (message == WM_NCHITTEST || message == WM_NCMOUSEMOVE || message == WM_NCMOUSELEAVE ||
        message == WM_NCLBUTTONDOWN || message == WM_NCLBUTTONUP || message == WM_NCLBUTTONDBLCLK) {
        LRESULT dwmResult = 0;
        if (DwmDefWindowProc(hwnd, message, wParam, lParam, &dwmResult)) return dwmResult;
    }

    if (message == WM_NCHITTEST) {
        POINT point{ GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam) };
        if (ScreenToClient(hwnd, &point)) {
            RECT client{};
            GetClientRect(hwnd, &client);
            auto it = captionDragRegions.find(hwnd);
            if (it != captionDragRegions.end() && point.y >= 0 && point.y < it->second.height) {
                const int nativeMaxButtonWidth = MulDiv(46, GetDpiForWindow(hwnd), USER_DEFAULT_SCREEN_DPI);
                if (point.x >= client.right - nativeMaxButtonWidth) {
                    // Windows 11 shows Snap Layouts for HTMAXBUTTON and then owns the
                    // maximize/snap animation. There is intentionally no app-drawn button.
                    return HTMAXBUTTON;
                }
                if (point.x >= 0 && point.x < client.right - it->second.rightExclusion) {
                    // Returning HTCAPTION hands dragging and edge snapping to the normal
                    // Windows non-client move loop (WM_NCLBUTTONDOWN / SC_MOVE).
                    return HTCAPTION;
                }
            }
        }
    }
    // Electron's frameless-window procedure can consume non-client caption
    // clicks. Invoke the Windows default procedure directly so the shell's
    // move loop, edge snap detection, and maximize animation remain native.
    if (message == WM_NCLBUTTONDOWN && (wParam == HTCAPTION || wParam == HTMAXBUTTON)) {
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
    if (message == WM_NCLBUTTONUP && wParam == HTMAXBUTTON) {
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
    if (message == WM_NCLBUTTONDBLCLK && wParam == HTCAPTION) {
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
    if (message == WM_NCDESTROY) {
        RemoveWindowSubclass(hwnd, CaptionDragSubclass, subclassId);
        captionDragRegions.erase(hwnd);
    }
    return DefSubclassProc(hwnd, message, wParam, lParam);
}

void EnsureCompositor()
{
    if (compositor) return;
    DispatcherQueueOptions options{ sizeof(DispatcherQueueOptions), DQTYPE_THREAD_CURRENT, DQTAT_COM_STA };
    winrt::check_hresult(::CreateDispatcherQueueController(options,
        reinterpret_cast<ABI::Windows::System::IDispatcherQueueController**>(winrt::put_abi(dispatcher))));
    compositor = Compositor();
}

WindowBackdrop& EnsureWindow(HWND hwnd)
{
    auto [it, inserted] = windows.try_emplace(hwnd);
    if (!inserted) return it->second;
    auto interop = compositor.as<ABI::Windows::UI::Composition::Desktop::ICompositorDesktopInterop>();
    winrt::check_hresult(interop->CreateDesktopWindowTarget(hwnd, FALSE,
        reinterpret_cast<ABI::Windows::UI::Composition::Desktop::IDesktopWindowTarget**>(winrt::put_abi(it->second.target))));
    auto& w = it->second;
    w.root = compositor.CreateContainerVisual();
    w.root.RelativeSizeAdjustment({ 1.0f, 1.0f });
    w.blur = compositor.CreateSpriteVisual();
    w.blur.RelativeSizeAdjustment({ 1.0f, 1.0f });
    w.tint = compositor.CreateSpriteVisual();
    w.tint.RelativeSizeAdjustment({ 1.0f, 1.0f });
    w.luminosity = compositor.CreateSpriteVisual();
    w.luminosity.RelativeSizeAdjustment({ 1.0f, 1.0f });
    w.root.Children().InsertAtBottom(w.blur);
    w.root.Children().InsertAtTop(w.luminosity);
    w.root.Children().InsertAtTop(w.tint);
    w.target.Root(w.root);

    BOOL hostBackdrop = TRUE;
    DwmSetWindowAttribute(hwnd, DWMWA_USE_HOSTBACKDROPBRUSH, &hostBackdrop, sizeof(hostBackdrop));
    const DWORD borderColor = RGB(57, 72, 91);
    const int roundedCorners = 2;
    DwmSetWindowAttribute(hwnd, static_cast<DWMWINDOWATTRIBUTE>(34), &borderColor, sizeof(borderColor));
    DwmSetWindowAttribute(hwnd, static_cast<DWMWINDOWATTRIBUTE>(33), &roundedCorners, sizeof(roundedCorners));
    return w;
}

Color LayerColor(uint32_t rgb, float alpha)
{
    Color c{};
    c.A = static_cast<uint8_t>(std::clamp(alpha, 0.0f, 1.0f) * 255.0f + 0.5f);
    c.R = static_cast<uint8_t>((rgb >> 16) & 0xff);
    c.G = static_cast<uint8_t>((rgb >> 8) & 0xff);
    c.B = static_cast<uint8_t>(rgb & 0xff);
    return c;
}

float BlurVisibility(float radius)
{
    return radius <= 0.0f ? 0.0f : 1.0f - std::exp(-radius / 4.0f);
}
}

extern "C" __declspec(dllexport) int __stdcall AdamCompositionSetCaptionDrag(
    uintptr_t handle, int height, int rightExclusion)
{
    HWND hwnd = reinterpret_cast<HWND>(handle);
    if (!IsWindow(hwnd)) return ERROR_INVALID_WINDOW_HANDLE;
    captionDragRegions[hwnd] = { height < 0 ? 0 : height, rightExclusion < 0 ? 0 : rightExclusion };
    if (!SetWindowSubclass(hwnd, CaptionDragSubclass, kCaptionDragSubclassId, 0)) {
        captionDragRegions.erase(hwnd);
        return static_cast<int>(GetLastError());
    }
    return ERROR_SUCCESS;
}

extern "C" __declspec(dllexport) int __stdcall AdamCompositionSetBackdrop(
    uintptr_t handle, float blurRadius, float saturation, uint32_t tintRgb, float tintOpacity,
    uint32_t luminosityRgb, float luminosityOpacity)
{
    try {
        HWND hwnd = reinterpret_cast<HWND>(handle);
        if (!IsWindow(hwnd)) return ERROR_INVALID_WINDOW_HANDLE;
        EnsureCompositor();
        auto& w = EnsureWindow(hwnd);
        EffectSourceParameter source(L"backdrop");
        auto sat = Microsoft::WRL::Make<Microsoft::UI::Composition::Effects::SaturationEffect>();
        winrt::check_hresult(sat->put_Saturation(std::clamp(saturation, 0.0f, 2.0f)));
        winrt::check_hresult(sat->put_Source(reinterpret_cast<ABI::Windows::Graphics::Effects::IGraphicsEffectSource*>(winrt::get_abi(source))));
        Microsoft::WRL::ComPtr<ABI::Windows::Graphics::Effects::IGraphicsEffectSource> saturated;
        winrt::check_hresult(sat.As(&saturated));
        Microsoft::WRL::ComPtr<ABI::Windows::Graphics::Effects::IGraphicsEffect> rawEffect;
        if (blurRadius <= 0.0f) {
            winrt::check_hresult(sat.As(&rawEffect));
        } else {
            auto blur = Microsoft::WRL::Make<Microsoft::UI::Composition::Effects::GaussianBlurEffect>();
            winrt::check_hresult(blur->put_BlurAmount(std::clamp(blurRadius, 0.0f, 30.0f)));
            winrt::check_hresult(blur->put_Source(saturated.Get()));
            winrt::check_hresult(blur.As(&rawEffect));
        }
        CompositionEffect effect{ nullptr };
        winrt::copy_from_abi(effect, rawEffect.Get());
        auto factory = compositor.CreateEffectFactory(effect);
        auto brush = factory.CreateBrush();
        brush.SetSourceParameter(L"backdrop", compositor.CreateHostBackdropBrush());
        w.blur.Brush(brush);
        w.tint.Brush(compositor.CreateColorBrush(LayerColor(tintRgb, tintOpacity)));
        w.luminosity.Brush(compositor.CreateColorBrush(LayerColor(luminosityRgb, luminosityOpacity)));
        const float visible = BlurVisibility(blurRadius);
        w.blur.Opacity(visible);
        w.tint.Opacity(visible);
        w.luminosity.Opacity(visible);
        return ERROR_SUCCESS;
    } catch (winrt::hresult_error const& e) {
        return static_cast<int>(e.code().value);
    } catch (...) {
        return ERROR_GEN_FAILURE;
    }
}

extern "C" __declspec(dllexport) void __stdcall AdamCompositionRemoveBackdrop(uintptr_t handle)
{
    HWND hwnd = reinterpret_cast<HWND>(handle);
    RemoveWindowSubclass(hwnd, CaptionDragSubclass, kCaptionDragSubclassId);
    captionDragRegions.erase(hwnd);
    auto it = windows.find(hwnd);
    if (it == windows.end()) return;
    try { it->second.target.Root(nullptr); } catch (...) {}
    windows.erase(it);
}
