#include <cassert>
#include <chrono>
#include <thread>

// Exercise the real worker/queue implementation with local refresh stubs.
#include "../native/main.cpp"

extern "C" void refresh_decrypt_ctx(void) {}
extern "C" int is_preshare_ctx_ready(void) { return 1; }

int main()
{
    start_recovery_thread();
    start_recovery_thread(); // starting twice must not spawn an orphan
    stop_recovery_thread(); // stop while waiting for an event
    stop_recovery_thread(); // idempotent
    start_recovery_thread();
    schedule_recovery(3084);
    for (int i = 0; i < 100 && get_recovery_state() == 0; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    assert(get_recovery_state() == 1);
    auto begin = std::chrono::steady_clock::now();
    stop_recovery_thread(); // interrupt the one-second backoff
    assert(std::chrono::steady_clock::now() - begin < std::chrono::milliseconds(500));
    assert(get_recovery_state() == 0);
    schedule_recovery(3084); // a late callback after shutdown is ignored
    start_recovery_thread();
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    assert(get_recovery_state() == 0);
    stop_recovery_thread();
    puts("native recovery lifecycle tests passed");
}
