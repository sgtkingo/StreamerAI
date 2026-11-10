import type { ViewerProfile } from "@streamer-ai/contracts";

export const avatarOptions = [
  { id: "sun", label: "Sun", icon: "☀️", color: "#a54c28" },
  { id: "moon", label: "Moon", icon: "🌙", color: "#303d79" },
  { id: "fox", label: "Fox", icon: "🦊", color: "#a15938" },
  { id: "cat", label: "Cat", icon: "🐱", color: "#66517c" },
  { id: "planet", label: "Planet", icon: "🪐", color: "#356c76" },
  { id: "film", label: "Film", icon: "🎬", color: "#555a67" },
] as const;

export function ProfileAvatar({
  name,
  avatar,
}: {
  name: string;
  avatar?: ViewerProfile["avatar"];
}) {
  if (avatar?.startsWith("data:image/jpeg;base64,")) {
    return <img className="profile-avatar__image" src={avatar} alt="" />;
  }
  const choice = avatarOptions.find((option) => option.id === avatar);
  if (choice)
    return (
      <span
        className="profile-avatar__preset"
        style={{ background: choice.color }}
        aria-hidden="true"
      >
        {choice.icon}
      </span>
    );
  return <>{name.slice(0, 1).toUpperCase()}</>;
}

export async function prepareProfilePhoto(file: File): Promise<string> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml")
    throw new Error("Choose a JPG, PNG, WebP or other image file.");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("Choose an image smaller than 10 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error("This image could not be opened.");
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 160;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This image could not be processed.");
    context.fillStyle = "#202026";
    context.fillRect(0, 0, 160, 160);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      160,
      160,
    );
    const result = canvas.toDataURL("image/jpeg", 0.8);
    if (result.length > 48000)
      throw new Error("This image could not be made small enough.");
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}
