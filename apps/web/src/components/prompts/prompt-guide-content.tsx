"use client";

import React from "react";

/**
 * The single "How to use a master prompt" guide for the Master
 * Prompts Library. Content is adapted faithfully from
 * ~/workspace/prompt-library/guide-how-to-use.md (the rewritten
 * guide): same steps, same wording for the reference step, no
 * CM Tool Hub branding, no per-prompt how-to content. This
 * guide replaces the per-prompt how-to sections that were
 * removed from the dedicated section.
 *
 * This is content only — it renders inside the guide popup
 * dialog (PromptGuideDialog), never as its own page. The
 * separate /prompts/guide page was removed on Shahzeb's order
 * ("open the guide in a popup not a page").
 */
export function PromptGuideContent() {
  return (
    <div data-testid="prompt-guide">
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        Learn how to use a Master Prompt from the Master Prompts
        Library. Copy the prompt, paste it into ChatGPT, choose one
        of the generated ideas, and receive a complete
        video-generation prompt you can use in your video tool.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        Using a Master Prompt is simple. You do not need to rewrite
        the prompt, understand prompt engineering, or build a
        video-generation prompt from scratch.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink">
        <span className="font-semibold">
          Copy the Master Prompt → Paste it into a new ChatGPT chat
          → Choose an idea by number → Provide a reference image,
          or use the built-in design, when asked → Receive your
          final video-generation prompt → Paste that into your
          video tool.
        </span>
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        Different Master Prompts may generate different types of
        content, but the basic process is usually the same.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        What you need before you start
      </h3>
      <ul className="mt-3 list-disc space-y-2 pl-6 text-sm leading-relaxed text-ink-sub">
        <li>
          A ChatGPT account, for running the Master Prompt workflow.
        </li>
        <li>
          An account with the video tool the prompt is made for —
          for example Seedance, Veo, Google Flow, or Dola AI. The
          prompt&apos;s tool is shown on its card.
        </li>
        <li>
          Nothing else. You do not need to install anything, and you
          do not need to edit the Master Prompt first.
        </li>
      </ul>

      <h3 className="mt-8 text-xl font-bold text-ink">
        What is a Master Prompt?
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        A Master Prompt is a reusable set of detailed instructions
        that guides ChatGPT through a specific content-generation
        workflow. Instead of giving ChatGPT a short request such as
        &ldquo;Give me an idea for a craft video,&rdquo; a Master
        Prompt already contains the instructions ChatGPT needs:
        what type of content to create, how many ideas to generate,
        what style to use, what information to ask you for, how the
        final video prompt should be structured, which visual and
        physical details should stay consistent, and how the final
        scene should end.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        This means you can reuse the same Master Prompt to create
        many different videos while keeping the format and quality
        consistent.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        Step 1: Find a Master Prompt
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        Browse the Master Prompts Library and choose a prompt based
        on the type of content you want to create — animal videos,
        comedy, cinematic scenes, UGC-style videos, tutorials,
        unboxings, or craft and transformation videos. Open the
        prompt&apos;s page to see its preview, description, tool,
        and full prompt.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        Step 2: Copy the full Master Prompt
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        On the prompt&apos;s page, click Copy. This copies the
        complete prompt to your clipboard. Copy the entire prompt,
        not just part of it. The full prompt contains the
        instructions ChatGPT needs to run the complete workflow
        correctly. Cutting it short is the most common reason a
        workflow does not work as expected.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        Step 3: Open a new ChatGPT conversation
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        Open ChatGPT and start a new chat. Paste the complete Master
        Prompt into the message box and send it. You normally do
        not need to add another instruction — the Master Prompt
        already tells ChatGPT what to do next. Start a new chat for
        each Master Prompt you use, so instructions from an earlier
        conversation do not affect the new workflow.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        Step 4: Let the Master Prompt generate ideas
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        After you send the Master Prompt, ChatGPT will begin the
        workflow defined inside it. Most Master Prompts first
        generate a list of content ideas — 10, 20, or another
        number defined by that prompt. Each idea will normally have
        a number. You do not need to rewrite the idea you want.
        Simply reply with its number, for example{" "}
        <span className="font-semibold text-ink">3</span>, and
        ChatGPT will continue with idea number 3.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        Step 5: Choose a reference image, or use the built-in
        design
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        Some Master Prompts ask for a reference image before
        generating the final video prompt.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        The reference is the prompt&apos;s own preview media. Every
        prompt page shows preview images and videos — those are the
        reference for that prompt. Use the Download button on the
        preview to save the image or video, then upload that file
        into ChatGPT when asked. A reference image can help
        establish details such as character appearance,
        environment, clothing, object design, layout, camera
        perspective, and overall visual style.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        If you do not want to use the preview as a reference,
        simply reply{" "}
        <span className="font-semibold text-ink">
          USE YOUR DESIGN
        </span>
        . ChatGPT will then create the scene using the design rules
        already contained inside the Master Prompt. Not every
        Master Prompt asks for a reference image. If yours does not
        ask, it will move straight to generating the final prompt —
        just follow the steps it gives you.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        Step 6: Receive the final video-generation prompt
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        After you select an idea — and provide a reference image or
        choose USE YOUR DESIGN, when asked — ChatGPT generates the
        complete video-generation prompt: subject, environment,
        actions, camera position and movement, lighting, physics,
        timing, scene progression, reactions, ending, negative
        constraints, and technical settings. Copy that final prompt
        and paste it into the video tool shown on the prompt&apos;s
        card. Before generating, quickly check that the details
        match what you want.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        Example: using a craft Master Prompt
      </h3>
      <ol className="mt-3 list-decimal space-y-2 pl-6 text-sm leading-relaxed text-ink-sub">
        <li>
          Copy the Cardboard Tube Bloom prompt from the library.
        </li>
        <li>Paste it into a new ChatGPT chat and send it.</li>
        <li>
          Review the 10 craft ideas it generates, each with a shape,
          central object, and colour palette.
        </li>
        <li>
          Choose one by replying with its number, e.g.{" "}
          <span className="font-semibold text-ink">2</span>.
        </li>
        <li>
          If asked, download the prompt&apos;s preview image and
          upload it as the reference, or reply USE YOUR DESIGN.
        </li>
        <li>
          Get the final 30-second video prompt, with timed stages,
          camera movement, and the final still hold.
        </li>
        <li>
          Paste that final prompt into Seedance (the tool for this
          prompt) and generate.
        </li>
      </ol>

      <h3 className="mt-8 text-xl font-bold text-ink">
        Do I need to edit the Master Prompt?
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        Usually, no. Use it exactly as provided first. Once you
        understand how it works, you can experiment with changing
        details — character type, location, clothing, environment,
        camera style, duration, mood — but removing important
        instructions may change the quality or structure of its
        output. If a result looks wrong after editing, go back to
        the original prompt and try again unedited.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        Can I generate more than one video from the same Master
        Prompt?
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        Yes. Reuse the same Master Prompt and select different
        generated ideas — first run idea 2, second run idea 7,
        third run idea 10. Each selection can lead to a different
        final prompt while following the same format and visual
        rules. You can also start a new chat and run the same
        Master Prompt again for a fresh set of ideas.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        What should I do with the final prompt?
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        Copy it and use it with the video tool that fits that
        prompt — check the tool shown on its card, since a prompt
        made for Seedance will not necessarily work the same way in
        another tool. You can also ask ChatGPT to change a specific
        detail before using it, without regenerating the entire
        Master Prompt.
      </p>

      <h3 className="mt-8 text-xl font-bold text-ink">
        If something goes wrong
      </h3>
      <ul className="mt-3 list-disc space-y-2 pl-6 text-sm leading-relaxed text-ink-sub">
        <li>
          <span className="font-semibold text-ink">
            ChatGPT does not generate ideas, or gives a short
            generic answer:
          </span>{" "}
          check that you pasted the entire Master Prompt, and that
          you are in a new chat. Pasting only part of it is the
          most common cause.
        </li>
        <li>
          <span className="font-semibold text-ink">
            The output ignores the style or format:
          </span>{" "}
          start a new chat and paste the full prompt again,
          unedited. Instructions from an earlier conversation can
          interfere.
        </li>
        <li>
          <span className="font-semibold text-ink">
            The final prompt does not fit your video tool:
          </span>{" "}
          check the tool shown on the prompt&apos;s card, and use
          that tool for the final prompt.
        </li>
        <li>
          <span className="font-semibold text-ink">
            You want a different idea:
          </span>{" "}
          reply with a different idea number, or start a new chat
          and run the same Master Prompt again.
        </li>
      </ul>

      <h3 className="mt-8 text-xl font-bold text-ink">
        The complete workflow
      </h3>
      <ol className="mt-3 list-decimal space-y-2 pl-6 text-sm leading-relaxed text-ink-sub">
        <li>Choose a Master Prompt from the Master Prompts Library.</li>
        <li>Click Copy on its page.</li>
        <li>Paste it into a new ChatGPT conversation.</li>
        <li>
          Choose one of the generated ideas by replying with its
          number.
        </li>
        <li>
          Upload a reference image, or reply &ldquo;USE YOUR
          DESIGN&rdquo;, when requested.
        </li>
        <li>
          Copy the final video-generation prompt and use it in the
          video tool shown on the prompt&apos;s card.
        </li>
      </ol>
      <p className="mt-3 text-sm leading-relaxed text-ink-sub">
        Once you have done it once, the process usually takes only
        a few simple interactions.
      </p>
    </div>
  );
}
