import { Crown } from "lucide-react";
import { Button } from "./ui/button";

type TeamDisplayMember = {
  userId: number;
  username: string;
  role: "captain" | "member";
};

type TeamDisplayTeam = {
  id: string;
  name: string;
  captainId: number;
  members: TeamDisplayMember[];
  teamSide?: "A" | "B";
};

type TeamDisplayProps = {
  team: TeamDisplayTeam;
  currentUserId?: number;
  onReady?: () => void;
  title?: string;
  isUserTeam?: boolean;
  isReady?: boolean;
};

const TeamDisplay = ({
  team,
  currentUserId,
  onReady,
  title,
  isUserTeam,
  isReady,
}: TeamDisplayProps) => {
  const isCaptain = currentUserId ? team.captainId === currentUserId : false;
  const canReady = Boolean(
    onReady &&
    isUserTeam &&
    isCaptain
  );

  return (
    <div className="bg-white p-4 rounded-lg shadow-sm border space-y-4">
      <div className="flex justify-between items-center">
        <div>
          {title && (
            <p className="text-xs uppercase tracking-wide text-gray-500">
              {title}
            </p>
          )}
          <h3 className="text-lg font-semibold text-gray-900">
            {team.name}{" "}
            {isUserTeam && (
              <span className="text-sm text-gray-500">(Your Team)</span>
            )}
            {isReady && (
              <span className="px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-700 border border-green-300">
                Ready
              </span>
            )}
          </h3>
        </div>
        {canReady && (
          <Button
            onClick={onReady}
            className="bg-green-600 hover:bg-green-700"
          >
            Ready to Play
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-gray-500 mb-2">Team Members</h4>
        <ul className="space-y-2">
          {team.members.map((member) => (
            <li
              key={member.userId}
              className="flex items-center justify-between p-2 bg-gray-50 rounded"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{member.username}</span>
                {member.role === "captain" && (
                  <Crown className="h-4 w-4 text-yellow-500" />
                )}
              </div>
              <span className="text-sm text-gray-500">
                {member.role === "captain" ? "Captain" : "Member"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default TeamDisplay;