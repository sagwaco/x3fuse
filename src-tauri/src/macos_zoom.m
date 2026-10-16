#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <stdbool.h>

// NSWindow's synchronous zoom animation starves WKWebView of viewport updates.
// Keep AppKit's target calculation, but return to the run loop between frames.
static char X3FuseZoomControllerKey;
static char X3FuseOriginalMethodsKey;
static NSMutableArray<Class> *X3FusePatchedWindowClasses;

@interface X3FuseZoomController : NSObject
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic, strong) CADisplayLink *displayLink;
@property(nonatomic) BOOL applyingFrame;
@property(nonatomic) BOOL calculatingTarget;
@property(nonatomic) BOOL hasZoomState;
@property(nonatomic) BOOL hasRestoreFrame;
@property(nonatomic) BOOL zoomed;
@property(nonatomic) NSRect restoreFrame;
@property(nonatomic) NSRect zoomFrame;
@property(nonatomic) NSRect lastFrame;
@property(nonatomic) NSRect startFrame;
@property(nonatomic) NSRect targetFrame;
@property(nonatomic) CFTimeInterval startTime;
@property(nonatomic) NSTimeInterval duration;
- (void)cancel;
- (void)zoom:(id)sender;
- (BOOL)reduceMotion;
@end

static X3FuseZoomController *X3FuseController(__unsafe_unretained NSWindow *window) {
    return objc_getAssociatedObject(window, &X3FuseZoomControllerKey);
}

// Methods live on the application's NSWindow subclass. Changing a live window's
// isa breaks AppKit's preexisting KVO registrations, even with a transparent -class.
static IMP X3FuseOriginalMethod(__unsafe_unretained NSWindow *window, SEL selector) {
    for (Class cls = object_getClass(window); cls; cls = class_getSuperclass(cls)) {
        NSDictionary *methods = objc_getAssociatedObject(cls, &X3FuseOriginalMethodsKey);
        NSValue *method = methods[NSStringFromSelector(selector)];
        if (method) return (IMP)method.pointerValue;
    }
    return NULL;
}

@implementation X3FuseZoomController

- (void)cancel {
    [self.displayLink invalidate];
    self.displayLink = nil;
}

- (void)dealloc {
    [_displayLink invalidate];
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (BOOL)reduceMotion {
    return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
}

- (void)applyFrame:(NSRect)frame display:(BOOL)display {
    self.applyingFrame = YES;
    @try {
        [self.window setFrame:frame display:display animate:NO];
        self.lastFrame = self.window.frame;
    } @finally {
        self.applyingFrame = NO;
    }
}

- (void)frameChanged:(NSNotification *)notification {
    if (self.applyingFrame || self.calculatingTarget) return;
    [self cancel];
    NSRect frame = self.window.frame;
    if (!NSEqualSizes(frame.size, self.lastFrame.size)) {
        self.hasZoomState = NO;
        self.hasRestoreFrame = NO;
    } else if (self.hasRestoreFrame && self.zoomed) {
        // Moving a zoomed window should not replace its original restore size.
        self.restoreFrame = NSOffsetRect(self.restoreFrame,
            frame.origin.x - self.lastFrame.origin.x,
            frame.origin.y - self.lastFrame.origin.y);
    }
    self.lastFrame = frame;
}

- (void)interrupted:(NSNotification *)notification {
    if (self.applyingFrame || self.calculatingTarget) return;
    [self cancel];
    if ([notification.name isEqualToString:NSWindowWillStartLiveResizeNotification] ||
        [notification.name isEqualToString:NSWindowWillEnterFullScreenNotification]) {
        self.hasZoomState = NO;
        self.hasRestoreFrame = NO;
    }
}

- (void)tick:(CADisplayLink *)link {
    NSWindow *window = self.window;
    if (!window) {
        [self cancel];
        return;
    }
    double progress = MIN(1.0, MAX(0.0,
        (link.targetTimestamp - self.startTime) / self.duration));
    if ([self reduceMotion]) progress = 1.0;
    double eased = progress * progress * (3.0 - 2.0 * progress);
    NSRect from = self.startFrame, to = self.targetFrame;
    NSRect frame = NSMakeRect(
        from.origin.x + (to.origin.x - from.origin.x) * eased,
        from.origin.y + (to.origin.y - from.origin.y) * eased,
        from.size.width + (to.size.width - from.size.width) * eased,
        from.size.height + (to.size.height - from.size.height) * eased);
    [self applyFrame:progress == 1.0 ? to : frame display:YES];
    if (progress == 1.0) [self cancel];
}

- (void)zoom:(id)sender {
    NSWindow *window = self.window;
    IMP originalZoom = X3FuseOriginalMethod(window, @selector(zoom:));
    if (window.styleMask & NSWindowStyleMaskFullScreen) {
        ((void (*)(id, SEL, id))originalZoom)(window, @selector(zoom:), sender);
        return;
    }
    BOOL reversing = self.displayLink != nil;
    BOOL wasZoomed = self.hasZoomState ? self.zoomed :
        ((BOOL (*)(id, SEL))X3FuseOriginalMethod(window, @selector(isZoomed)))(
            window, @selector(isZoomed));
    [self cancel];
    NSRect start = window.frame;
    NSRect target;
    if (reversing) {
        target = wasZoomed ? self.restoreFrame : self.zoomFrame;
    } else {
        if (!wasZoomed) {
            self.restoreFrame = start;
            self.hasRestoreFrame = YES;
        }
        // AppKit still chooses the standard frame and consults Tao's delegate.
        // Restore the starting frame in this same run-loop turn, before presentation.
        self.calculatingTarget = YES;
        @try {
            ((void (*)(id, SEL, id))originalZoom)(window, @selector(zoom:), sender);
            target = window.frame;
            if (NSEqualRects(start, target)) return; // Native zoom was refused.
            if (wasZoomed) {
                self.zoomFrame = start;
                if (!self.hasRestoreFrame) {
                    self.restoreFrame = target;
                    self.hasRestoreFrame = YES;
                }
                target = self.restoreFrame;
            } else {
                self.zoomFrame = target;
            }
            [self applyFrame:start display:NO];
        } @finally {
            self.calculatingTarget = NO;
        }
    }
    self.hasZoomState = YES;
    self.zoomed = !wasZoomed;
    self.startFrame = start;
    self.targetFrame = target;
    self.duration = [window animationResizeTime:target];
    if ([self reduceMotion] || self.duration <= 0 || NSEqualRects(start, target)) {
        [self applyFrame:target display:YES];
        return;
    }
    self.startTime = CACurrentMediaTime();
    self.displayLink = [window displayLinkWithTarget:self selector:@selector(tick:)];
    NSInteger refreshRate = window.screen.maximumFramesPerSecond;
    if (refreshRate > 0) {
        self.displayLink.preferredFrameRateRange = CAFrameRateRangeMake(MIN(30, refreshRate), refreshRate, refreshRate);
    }
    [self.displayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}
@end

static void X3FuseZoom(__unsafe_unretained NSWindow *window, SEL command, id sender) {
    X3FuseZoomController *controller = X3FuseController(window);
    if (controller) [controller zoom:sender];
    else ((void (*)(id, SEL, id))X3FuseOriginalMethod(window, command))(window, command, sender);
}

static BOOL X3FuseIsZoomed(__unsafe_unretained NSWindow *window, SEL command) {
    X3FuseZoomController *controller = X3FuseController(window);
    if (controller.hasZoomState) return controller.zoomed;
    return ((BOOL (*)(id, SEL))X3FuseOriginalMethod(window, command))(window, command);
}

static BOOL X3FuseIsZoomAnimating(__unsafe_unretained NSWindow *window, __unused SEL command) {
    return X3FuseController(window).displayLink != nil;
}

static void X3FuseSetFrame(__unsafe_unretained NSWindow *window, SEL command, NSRect frame, BOOL display) {
    X3FuseZoomController *controller = X3FuseController(window);
    if (!controller.applyingFrame && !controller.calculatingTarget) [controller cancel];
    ((void (*)(id, SEL, NSRect, BOOL))X3FuseOriginalMethod(window, command))(
        window, command, frame, display);
}

static void X3FuseSetFrameAnimated(__unsafe_unretained NSWindow *window, SEL command, NSRect frame,
                                  BOOL display, BOOL animate) {
    X3FuseZoomController *controller = X3FuseController(window);
    if (controller.calculatingTarget) animate = NO;
    else if (!controller.applyingFrame) [controller cancel];
    ((void (*)(id, SEL, NSRect, BOOL, BOOL))X3FuseOriginalMethod(window, command))(
        window, command, frame, display, animate);
}

static void X3FuseInterruptWithSender(__unsafe_unretained NSWindow *window, SEL command, id sender) {
    X3FuseZoomController *controller = X3FuseController(window);
    [controller cancel];
    if (command == @selector(toggleFullScreen:)) {
        controller.hasZoomState = NO;
        controller.hasRestoreFrame = NO;
    }
    ((void (*)(id, SEL, id))X3FuseOriginalMethod(window, command))(window, command, sender);
}

static void X3FuseClose(__unsafe_unretained NSWindow *window, SEL command) {
    [X3FuseController(window) cancel];
    ((void (*)(id, SEL))X3FuseOriginalMethod(window, command))(window, command);
}

static void X3FuseDealloc(__unsafe_unretained NSWindow *window, SEL command) {
    [X3FuseController(window) cancel];
    ((void (*)(id, SEL))X3FuseOriginalMethod(window, command))(window, command);
}

bool x3fuse_install_smooth_zoom(void *nativeWindow) {
    if (![NSThread isMainThread] || !nativeWindow) return false;
    NSWindow *window = (__bridge NSWindow *)nativeWindow;
    if (![window isKindOfClass:NSWindow.class]) return false;
    if (X3FuseController(window)) return true;
    Class windowClass = window.class;
    // The hook supplies TaoWindow; never patch AppKit's NSWindow/NSPanel bases.
    if (windowClass == NSWindow.class || windowClass == NSPanel.class) return false;
    BOOL installed = NO;
    for (Class cls = windowClass; cls; cls = class_getSuperclass(cls)) {
        if (objc_getAssociatedObject(cls, &X3FuseOriginalMethodsKey)) {
            installed = YES;
            break;
        }
    }
    if (!installed) {
        // Installing on an ancestor after a descendant would make the saved
        // descendant IMP's super call reenter itself through that ancestor.
        for (Class patched in X3FusePatchedWindowClasses) {
            for (Class cls = class_getSuperclass(patched); cls; cls = class_getSuperclass(cls)) {
                if (cls == windowClass) return false;
            }
        }
        struct { SEL selector; IMP implementation; } methods[] = {
            {@selector(zoom:), (IMP)X3FuseZoom},
            {@selector(isZoomed), (IMP)X3FuseIsZoomed},
            {@selector(setFrame:display:), (IMP)X3FuseSetFrame},
            {@selector(setFrame:display:animate:), (IMP)X3FuseSetFrameAnimated},
            {@selector(performWindowDragWithEvent:), (IMP)X3FuseInterruptWithSender},
            {@selector(miniaturize:), (IMP)X3FuseInterruptWithSender},
            {@selector(toggleFullScreen:), (IMP)X3FuseInterruptWithSender},
            {@selector(close), (IMP)X3FuseClose},
            {NSSelectorFromString(@"dealloc"), (IMP)X3FuseDealloc},
        };
        NSMutableDictionary *originals = [NSMutableDictionary dictionary];
        for (NSUInteger i = 0; i < sizeof(methods) / sizeof(methods[0]); i++) {
            Method method = class_getInstanceMethod(windowClass, methods[i].selector);
            if (!method) return false;
            originals[NSStringFromSelector(methods[i].selector)] =
                [NSValue valueWithPointer:(const void *)method_getImplementation(method)];
        }
        // Publish every original before replacing any method; new, uninstalled
        // sibling windows must always be able to call through to native behavior.
        objc_setAssociatedObject(windowClass, &X3FuseOriginalMethodsKey,
                                 originals, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        for (NSUInteger i = 0; i < sizeof(methods) / sizeof(methods[0]); i++) {
            Method method = class_getInstanceMethod(windowClass, methods[i].selector);
            class_replaceMethod(windowClass, methods[i].selector,
                                methods[i].implementation, method_getTypeEncoding(method));
        }
        class_addMethod(windowClass, NSSelectorFromString(@"x3fuseIsZoomAnimating"),
                        (IMP)X3FuseIsZoomAnimating,
                        method_getTypeEncoding(class_getInstanceMethod(windowClass, @selector(isZoomed))));
        if (!X3FusePatchedWindowClasses) X3FusePatchedWindowClasses = [NSMutableArray array];
        [X3FusePatchedWindowClasses addObject:windowClass];
    }
    X3FuseZoomController *controller = [X3FuseZoomController new];
    controller.window = window;
    controller.lastFrame = window.frame;
    objc_setAssociatedObject(window, &X3FuseZoomControllerKey,
                             controller, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    NSNotificationCenter *notifications = NSNotificationCenter.defaultCenter;
    for (NSNotificationName notification in @[
            NSWindowDidResizeNotification, NSWindowDidMoveNotification]) {
        [notifications addObserver:controller selector:@selector(frameChanged:)
                              name:notification object:window];
    }
    for (NSNotificationName notification in @[
            NSWindowWillMoveNotification, NSWindowWillStartLiveResizeNotification,
            NSWindowWillMiniaturizeNotification, NSWindowWillEnterFullScreenNotification,
            NSWindowWillCloseNotification]) {
        [notifications addObserver:controller selector:@selector(interrupted:)
                              name:notification object:window];
    }
    return true;
}
