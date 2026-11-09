import { useState } from "react";

const questions = [
  {
    question: "How do I connect another device?",
    answer:
      "Open the StreamerAI client on the device and select your home server. Approve its pairing request in Devices, or enter the household Master PIN on the device.",
  },
  {
    question: "Why can't my client find the home server?",
    answer:
      "Check that the server is running and both devices can reach each other on the network. VPNs, network isolation and Docker can block discovery; enter the server's network address manually in the client.",
  },
  {
    question: "What is the Master PIN?",
    answer:
      "The eight-digit Master PIN protects household administration and encrypted household backups. It can also authorize a device or unlock a profile. Keep it safe: backup files require the PIN that was used when they were created.",
  },
  {
    question: "I forgot my Master PIN. What can I do?",
    answer:
      "If this household is connected to a cloud account, use Forgot PIN on the administration sign-in screen and confirm ownership through that account. Without cloud access, changing the PIN requires the current PIN. Existing backups still require their original PIN.",
  },
  {
    question: "How do I change a profile PIN?",
    answer:
      "Open the player, choose the profile and use Profile privacy. The household owner can also reset a profile PIN in Profiles in this administration interface.",
  },
  {
    question: "Does my household work without the cloud?",
    answer:
      "Yes. Your home server stores the household locally and clients connect to it. Cloud management, synchronization and cloud backups require a connected account and an internet connection.",
  },
  {
    question: "How do I connect or disconnect the cloud?",
    answer:
      "Open Cloud in household administration. Connecting or disconnecting cloud services leaves your local household and profiles on the server.",
  },
  {
    question: "How do I back up or restore a household?",
    answer:
      "Use Backups to create an encrypted household backup and configure automatic backups. To restore on a new server, choose import or cloud restore during household setup and enter the Master PIN used for that backup.",
  },
  {
    question: "Where are my streaming services configured?",
    answer:
      "Open Services in household administration to manage the services shared by your household's profiles.",
  },
];

export function SupportFaq() {
  const [query, setQuery] = useState("");
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = questions.filter(({ question, answer }) => {
    const content = `${question} ${answer}`.toLocaleLowerCase();
    return words.every((word) => content.includes(word));
  });
  return (
    <section
      className="profile-page__section support-faq"
      aria-labelledby="faq-title"
    >
      <p className="eyebrow">Help</p>
      <h2 id="faq-title">Frequently asked questions</h2>
      <label className="field">
        <span>Search questions and answers</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search for pairing, PIN, backups…"
        />
      </label>
      <p className="settings-note" role="status">
        {matches.length} {matches.length === 1 ? "answer" : "answers"}
      </p>
      <div className="support-faq__list">
        {matches.map(({ question, answer }) => (
          <details key={question}>
            <summary>{question}</summary>
            <p>{answer}</p>
          </details>
        ))}
      </div>
      {matches.length === 0 && (
        <p>
          No answers found. Try a different search or report a problem below.
        </p>
      )}
    </section>
  );
}
