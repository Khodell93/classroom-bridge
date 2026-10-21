# Classroom Bridge — project brief

An iPad Safari Home-Screen web app (`public/`, Cloudflare Worker for signalling only) plus a Windows/Mac
companion (`pc-companion/`) on the classroom PC, which is connected to the projector by HDMI. iPad ↔ PC is
WebRTC peer-to-peer. Constraints: free solutions only (no paid Cloudflare plan, no paid code-signing accounts),
a Safari web app rather than a native iPad app, and never bypass school security controls.

The owner's three goals, in their words:

> The app has the first two parts working mostly at the moment. Part three we are stuck at.
>
> 1. The pc screen is shown on the ipad, and the teacher can control the pc from the ipad. The teacher can use
>    their finger as the mouse, use a pen to annotate over the screen.
> 2. Camera / visualiser - this works functionally, but needs improvements, the current code is to slow,
>    resulting in poor image quality, which does not improve, even if a picture is taken and the image is still.
>    If a full code rewrite is needed to improve this, so be it. This will probably be the main function for most
>    teachers, so needs to be as good as a paid app.
> 3. I would like teachers to be able to open apps / documents / files from onedrive and edit them directly on
>    the ipad, as they would normally do, as if they were not using the classroom bridge app. I would like this
>    screen to show up in the pc companion app, as part of the purpose is that the whole app works through that,
>    is seemless and works without thinkning for the teacher.

Everything should work "without thinking" for teachers. See README.md for how the pieces fit together.
