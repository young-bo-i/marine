export const Logo = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={1200}
    height={1200}
    role="graphics-symbol img"
    fill="none"
    viewBox="98 96 316 316"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <title>Marine</title>
    <path
      d="M136 344V174C136 157 156 149 168 161L256 256L344 161C356 149 376 157 376 174V344"
      stroke="currentColor"
      strokeWidth={40}
    />
    <path
      d="M136 310C178 268 214 268 256 310C298 352 334 352 376 310"
      stroke="#3b82f6"
      strokeWidth={36}
    />
    <circle cx={256} cy={310} r={15} fill="#3b82f6" />
  </svg>
);
