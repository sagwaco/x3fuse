// Run from the repo root (requires a logged-in macOS desktop):
// clang -fobjc-arc -mmacosx-version-min=14.0 -framework AppKit -framework WebKit \
//   -framework QuartzCore tauri/tests/native-zoom.m -o /tmp/x3fuse-native-zoom && /tmp/x3fuse-native-zoom
#import <WebKit/WebKit.h>
#include "../src-tauri/src/macos_zoom.m"

static void Check(BOOL condition, NSString *message) {
    if (!condition) {
        fprintf(stderr, "FAIL: %s\n", message.UTF8String);
        exit(1);
    }
}

static void Pump(void) {
    @autoreleasepool {
        NSEvent *event;
        while ((event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                          untilDate:NSDate.distantPast
                                             inMode:NSDefaultRunLoopMode dequeue:YES])) {
            [NSApp sendEvent:event];
        }
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
    }
}

static void Wait(BOOL (^complete)(void), NSTimeInterval timeout, NSString *message) {
    NSTimeInterval deadline = NSDate.timeIntervalSinceReferenceDate + timeout;
    while (!complete() && NSDate.timeIntervalSinceReferenceDate < deadline) Pump();
    Check(complete(), message);
}

static id JavaScript(WKWebView *webview, NSString *script) {
    __block BOOL complete = NO;
    __block id result;
    [webview evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        Check(error == nil, error.localizedDescription ?: @"JavaScript evaluation");
        result = value;
        complete = YES;
    }];
    Wait(^BOOL { return complete; }, 5, @"WebKit response timed out");
    return result;
}

// A real superclass and ivar catch replacing Tao's class or forwarding to NSWindow directly.
@interface TestWindow : NSWindow
@property(nonatomic) NSInteger sentinel;
@property(nonatomic) NSUInteger zoomCalls;
@end
@implementation TestWindow
- (void)zoom:(id)sender { self.zoomCalls++; [super zoom:sender]; }
- (NSTimeInterval)animationResizeTime:(NSRect)frame { return 0.35; }
@end

@interface ChildTestWindow : TestWindow @end
@implementation ChildTestWindow @end
@interface OtherTestWindow : NSWindow @end
@implementation OtherTestWindow @end
@interface OtherChildTestWindow : OtherTestWindow @end
@implementation OtherChildTestWindow @end

@interface NSWindow (ZoomTesting)
- (BOOL)x3fuseIsZoomAnimating;
@end

static BOOL TestReduceMotion;
@interface TestZoomController : X3FuseZoomController
@end
@implementation TestZoomController
- (BOOL)reduceMotion { return TestReduceMotion; }
@end

@interface TestDelegate : NSObject <NSWindowDelegate>
@property(nonatomic) NSUInteger resizeCalls;
@property(nonatomic) NSUInteger observationCalls;
@end
@implementation TestDelegate
- (NSRect)windowWillUseStandardFrame:(NSWindow *)window defaultFrame:(NSRect)frame {
    return NSInsetRect(window.screen.visibleFrame, 30, 30);
}
- (void)windowDidResize:(NSNotification *)notification { self.resizeCalls++; }
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object
                       change:(NSDictionary *)change context:(void *)context {
    Check([keyPath isEqualToString:@"sentinel"], @"expected native KVO observation");
    self.observationCalls++;
}
@end

static X3FuseZoomController *Controller(NSWindow *window) {
    return objc_getAssociatedObject(window, &X3FuseZoomControllerKey);
}

static BOOL Near(NSRect a, NSRect b) {
    return fabs(a.origin.x - b.origin.x) <= 1 && fabs(a.origin.y - b.origin.y) <= 1 &&
           fabs(a.size.width - b.size.width) <= 1 && fabs(a.size.height - b.size.height) <= 1;
}

static NSWindow *BareWindow(Class windowClass) {
    NSWindow *window = [[windowClass alloc]
        initWithContentRect:NSMakeRect(130, 140, 480, 320)
                  styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                            NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                    backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    return window;
}

static TestWindow *UninstalledWindow(TestDelegate *delegate) {
    TestWindow *window = (TestWindow *)BareWindow(TestWindow.class);
    window.delegate = delegate;
    window.sentinel = 193;
    return window;
}

static TestWindow *MakeWindow(TestDelegate *delegate) {
    TestWindow *window = UninstalledWindow(delegate);
    Class originalClass = object_getClass(window);
    Check(x3fuse_install_smooth_zoom((__bridge void *)window), @"install controller");
    Class installedClass = object_getClass(window);
    Check(installedClass == originalClass, @"installation preserves AppKit runtime class and KVO");
    X3FuseZoomController *controller = Controller(window);
    Check(controller != nil, @"controller is associated with its window");
    Check(x3fuse_install_smooth_zoom((__bridge void *)window), @"repeat installation");
    Check(object_getClass(window) == installedClass && Controller(window) == controller,
          @"installation is idempotent");
    object_setClass(controller, TestZoomController.class);
    Check(window.sentinel == 193 && [window isKindOfClass:TestWindow.class],
          @"native superclass and ivars survive installation");
    Check(window.delegate == delegate, @"native delegate is preserved");
    [window orderFrontRegardless];
    return window;
}

static void FinishZoom(NSWindow *window) {
    Wait(^BOOL { return ![window x3fuseIsZoomAnimating]; }, 2, @"zoom animation completed");
}

static void CheckViewportAnimation(TestWindow *window, WKWebView *webview, NSString *label) {
    JavaScript(webview, @"samples = []; sample();");
    [window zoom:nil];
    Check([window x3fuseIsZoomAnimating], [label stringByAppendingString:@" started"]);
    FinishZoom(window);
    // WebKit delivers the final resize asynchronously after the last native frame.
    JavaScript(webview, @"sample();");
    NSArray *samples = JavaScript(webview, @"samples");
    NSMutableSet *sizes = [NSMutableSet set];
    for (NSArray<NSNumber *> *sample in samples) {
        Check(fabs(sample[0].doubleValue - sample[2].doubleValue) <= 1 &&
              fabs(sample[1].doubleValue - sample[3].doubleValue) <= 1,
              [label stringByAppendingString:@" root layout follows viewport"]);
        [sizes addObject:[NSString stringWithFormat:@"%@x%@", sample[0], sample[1]]];
    }
    Check(sizes.count >= 4, [label stringByAppendingString:@" has intermediate WebKit layouts"]);
    NSArray<NSNumber *> *last = samples.lastObject;
    Check(fabs(last[0].doubleValue - webview.bounds.size.width) <= 1 &&
          fabs(last[1].doubleValue - webview.bounds.size.height) <= 1,
          [label stringByAppendingString:@" ends at native content bounds"]);
    printf("%s: %lu distinct viewport sizes\n", label.UTF8String, (unsigned long)sizes.count);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp finishLaunching];
        TestDelegate *delegate = [TestDelegate new];
        __weak X3FuseZoomController *closingController;
        @autoreleasepool {
            TestWindow *window = MakeWindow(delegate);
            [window addObserver:delegate forKeyPath:@"sentinel" options:0 context:NULL];
            window.sentinel = 194;
            Check(delegate.observationCalls == 1 && object_getClass(window) != TestWindow.class,
                  @"KVO can subclass the installed window and observe original ivars");
            WKWebView *webview = [[WKWebView alloc] initWithFrame:window.contentView.bounds];
            webview.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
            [window.contentView addSubview:webview];
            [webview loadHTMLString:@"<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:linear-gradient(45deg,#243,#79a)}</style><script>var samples=[];function sample(){let r=document.documentElement.getBoundingClientRect();samples.push([innerWidth,innerHeight,r.width,r.height])}addEventListener('resize',sample);sample();</script>" baseURL:nil];
            Wait(^BOOL { return !webview.loading && webview.URL != nil; }, 5, @"WebKit loaded test page");
            Check([JavaScript(webview, @"typeof sample") isEqual:@"function"], @"test page is ready");

            NSRect original = window.frame;
            CheckViewportAnimation(window, webview, @"zoom");
            NSRect zoomed = window.frame;
            Check(!Near(original, zoomed), @"zoom changes window size");
            CheckViewportAnimation(window, webview, @"restore");
            Check(Near(window.frame, original), @"restore returns to original rectangle");
            Check(window.zoomCalls >= 2 && delegate.resizeCalls > 2, @"superclass zoom and delegate callbacks run");

            [window zoom:nil];
            Wait(^BOOL { return !Near(window.frame, original); }, 1, @"animation begins before reversal");
            Check(window.zoomed, @"zoom state reflects destination during animation");
            [window zoom:nil];
            Check(!window.zoomed, @"rapid second zoom requests restore");
            FinishZoom(window);
            Check(Near(window.frame, original), @"rapid reversal preserves original restore rectangle");

            [window zoom:nil];
            FinishZoom(window);
            [window setFrameOrigin:NSMakePoint(window.frame.origin.x + 18, window.frame.origin.y - 12)];
            [window zoom:nil];
            FinishZoom(window);
            Check(fabs(window.frame.size.width - original.size.width) <= 1 &&
                  fabs(window.frame.size.height - original.size.height) <= 1,
                  @"moving a zoomed window preserves restore size");

            NSRect resized = NSMakeRect(150, 160, 540, 380);
            [window zoom:nil];
            Wait(^BOOL { return [window x3fuseIsZoomAnimating]; }, 1, @"zoom started before external resize");
            [window setFrame:resized display:YES];
            Check(![window x3fuseIsZoomAnimating], @"external resize cancels animation");
            Check(Near(window.frame, resized), @"external resize keeps requested bounds");
            [window zoom:nil];
            FinishZoom(window);
            [window zoom:nil];
            FinishZoom(window);
            Check(Near(window.frame, resized), @"manual resize becomes the next restore rectangle");

            [window zoom:nil];
            [window setFrameOrigin:NSMakePoint(180, 180)];
            Check(![window x3fuseIsZoomAnimating], @"external move cancels animation");

            TestReduceMotion = YES;
            [window zoom:nil];
            Check(![window x3fuseIsZoomAnimating], @"Reduce Motion zoom is immediate");
            NSRect reducedFrame = window.frame;
            [window zoom:nil];
            Check(![window x3fuseIsZoomAnimating], @"Reduce Motion restore is immediate");
            Check(!Near(window.frame, reducedFrame), @"Reduce Motion still changes zoom bounds");
            TestReduceMotion = NO;

            [window zoom:nil];
            Check([window x3fuseIsZoomAnimating], @"animation active before close");
            closingController = Controller(window);
            [window removeObserver:delegate forKeyPath:@"sentinel"];
            [window close];
            Check(![window x3fuseIsZoomAnimating], @"close invalidates display link");
            window = nil;
            webview = nil;
        }
        Wait(^BOOL { return closingController == nil; }, 2, @"closed controller deallocates");

        @autoreleasepool {
            for (Class windowClass in @[NSWindow.class, NSPanel.class]) {
                NSWindow *native = BareWindow(windowClass);
                Check(!x3fuse_install_smooth_zoom((__bridge void *)native), @"system classes remain untouched");
            }
            NSWindow *child = BareWindow(ChildTestWindow.class);
            Check(x3fuse_install_smooth_zoom((__bridge void *)child), @"child reuses installed ancestor hooks");
            NSWindow *otherChild = BareWindow(OtherChildTestWindow.class);
            Check(x3fuse_install_smooth_zoom((__bridge void *)otherChild), @"independent descendant installs");
            NSWindow *otherParent = BareWindow(OtherTestWindow.class);
            Check(!x3fuse_install_smooth_zoom((__bridge void *)otherParent),
                  @"installing ancestor of patched descendant is safely rejected");
        }

        TestWindow *reopened = MakeWindow(delegate);
        [reopened zoom:nil];
        Check([reopened x3fuseIsZoomAnimating], @"recreated window installs animation");
        [reopened close];

        @autoreleasepool {
            TestWindow *sibling = UninstalledWindow(delegate);
            [sibling orderFrontRegardless];
            NSRect initial = sibling.frame;
            Check(Controller(sibling) == nil, @"sibling has no installed controller");
            [sibling zoom:nil];
            Check(![sibling x3fuseIsZoomAnimating] && !Near(sibling.frame, initial),
                  @"uninstalled sibling retains native zoom");
            [sibling zoom:nil];
            Check(Near(sibling.frame, initial) && sibling.zoomCalls == 2,
                  @"uninstalled sibling forwards native restore and superclass methods");
            [sibling close];
        }

        @autoreleasepool {
            TestWindow *prezoomed = UninstalledWindow(delegate);
            [prezoomed orderFrontRegardless];
            NSRect initial = prezoomed.frame;
            [prezoomed zoom:nil];
            NSRect standard = prezoomed.frame;
            Check(prezoomed.zoomed, @"native zoom precedes installation");
            Check(x3fuse_install_smooth_zoom((__bridge void *)prezoomed), @"install on zoomed window");
            object_setClass(Controller(prezoomed), TestZoomController.class);
            [prezoomed zoom:nil];
            Wait(^BOOL { return !Near(prezoomed.frame, standard); }, 1, @"preexisting zoom starts restore");
            [prezoomed zoom:nil];
            FinishZoom(prezoomed);
            Check(Near(prezoomed.frame, standard), @"reversal preserves preexisting zoom frame");
            [prezoomed zoom:nil];
            FinishZoom(prezoomed);
            Check(Near(prezoomed.frame, initial), @"preexisting native restore frame survives installation");
            [prezoomed close];
        }

        __weak TestWindow *abandonedWindow;
        __weak X3FuseZoomController *abandonedController;
        @autoreleasepool {
            TestWindow *abandoned = MakeWindow(delegate);
            [abandoned orderOut:nil];
            [abandoned zoom:nil];
            Check([abandoned x3fuseIsZoomAnimating], @"animation active before dealloc without close");
            abandonedWindow = abandoned;
            abandonedController = Controller(abandoned);
        }
        Wait(^BOOL { return abandonedWindow == nil && abandonedController == nil; }, 2,
             @"window and controller deallocate during animation without close");
        printf("PASS: native zoom, restoration, reversal, interruptions, Reduce Motion, and lifetime\n");
    }
    return 0;
}
