import React from "react";

interface DownloadIconProps {
  size?: number;
  color?: string;
  speed?: number;
  strokeWidth?: number;
  className?: string;
}

export function DownloadingIcon({
  size = 24,
  color = "currentColor",
  speed = 1.2,
  strokeWidth = 2,
  className = "",
}: DownloadIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      style={
        {
          "--download-speed": `${speed}s`,
        } as React.CSSProperties
      }
    >
      {/* Arrow */}
      <g className="download-arrow">
        <path d="M12 15V3" />
        <path d="m7 10 5 5 5-5" />
      </g>

      {/* Fixed bracket */}
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />

      <style>
        {`
          .download-arrow {
            animation: download-arrow-move var(--download-speed)
              linear infinite;
          }

          @keyframes download-arrow-move {
            0% {
              transform: translateY(-10px);
              opacity: 0;
            }

            10% {
              transform: translateY(-5px);
              opacity: 1;
            }

            65% {
              transform: translateY(4px);
              opacity: 1;
            }

            80% {
              transform: translateY(10px);
              opacity: 0;
            }

            100% {
              transform: translateY(10px);
              opacity: 0;
            }
          }
        `}
      </style>
    </svg>
  );
}