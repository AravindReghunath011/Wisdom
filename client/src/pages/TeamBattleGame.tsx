import React, { useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Clock, Users, Crown, Check, X } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { setupGameSocket, sendGameEvent } from '@/lib/socket';
import TeamBattleQuestionBoard, {
  SuggestionsByAnswerId,
} from '@/components/TeamBattleQuestionBoard';
import FeedbackModal from '@/components/FeedbackModal';
import { initSounds, isSoundEnabled, isVoiceEnabled } from '@/lib/sounds';
import GameHeader from '@/components/GameHeader';

interface TeamMember {
  userId: number;
  username: string;
  role: "captain" | "member";
  joinedAt: Date;
}

interface Team {
  id: string;
  name: string;
  captainId: number;
  gameSessionId: string;
  members: TeamMember[];
  score: number;
  correctAnswers: number;
  incorrectAnswers: number;
  status: "forming" | "ready" | "playing" | "finished";
}

interface Question {
  id: string;
  text: string;
  answers: Array<{
    id: string;
    text: string;
    isCorrect: boolean;
  }>;
  category: string;
  difficulty: string;
  timeLimit?: number;
}

interface GameState {
  phase: 'waiting' | 'ready' | 'playing' | 'question' | 'results' | 'finished';
  currentQuestion?: Question;
  questionNumber?: number;
  totalQuestions?: number;
  timeRemaining?: number;
  teams?: Team[];
  playerTeam?: Team;
  opposingTeam?: Team;
  finalScore?: number;
  correct?: number;
  incorrect?: number;
}

export default function TeamBattleGame() {
  const [_, setLocation] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  
  const [gameState, setGameState] = useState<GameState>({ phase: 'waiting' });
  const gameStateRef = useRef<GameState>(gameState);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [teamAnswer, setTeamAnswer] = useState<string | null>(null);
  const [memberAnswers, setMemberAnswers] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionsByAnswerId>({});
  const [waitingForResults, setWaitingForResults] = useState(false);
  const [correctAnswerId, setCorrectAnswerId] = useState<string | null>(null);
  const [showRoundFeedback, setShowRoundFeedback] = useState(false);
  const [lastRoundCorrect, setLastRoundCorrect] = useState<boolean | null>(null);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => isSoundEnabled());
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(() => isVoiceEnabled());

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    if (lastRoundCorrect !== null) {
      setShowRoundFeedback(true);
    }
  }, [lastRoundCorrect]);

  // Get game session ID from URL
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const params = new URLSearchParams(search);
  const gameSessionId = params.get('session') ?? params.get('gameSessionId');

  useEffect(() => {
    if (!user || !gameSessionId) {
      setLocation('/');
      return;
    }

    // Setup WebSocket connection
    const socket = setupGameSocket(user.id);
    
    // Proactively request current game state for this team battle session
    sendGameEvent({
      type: 'get_game_state',
      gameSessionId,
      userId: user.id,
    });

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        console.log('Team Battle Game Event:', data);

        switch (data.type) {
          case 'connection_established':
            setConnected(true);
            break;

          case 'authenticated':
            console.log('Player authenticated for team battle');
            break;

          case 'game_state_update':
            updateGameState(data);
            break;

          case 'team_battle_started':
            setGameState(prev => ({ ...prev, phase: 'playing' }));
            toast({
              title: "Battle Started!",
              description: "The team battle has begun. Get ready for questions!"
            });
            break;

          case 'team_battle_question':
            setGameState(prev => ({
              ...prev,
              phase: 'question',
              currentQuestion: data.question,
              questionNumber: data.questionNumber,
              totalQuestions: data.totalQuestions,
              timeRemaining: data.timeLimit || 15
            }));
            setSelectedAnswer(null);
            setHasSubmitted(false);
            setTeamAnswer(null);
            setMemberAnswers({});
            setSuggestions({});
            setWaitingForResults(false);
            setCorrectAnswerId(null);
            setLastRoundCorrect(null);
            break;

          case 'team_answer_submitted':
            if (data.userId !== user.id) {
              setMemberAnswers(prev => ({
                ...prev,
                [data.username]: data.answerId
              }));
            }
            break;

          case 'team_option_selected': {
            // Lightweight per-click suggestion update. We intentionally avoid
            // relying on gameState here so this works reliably for all
            // teammates as events stream in from the server.
            if (!data.teamId || !data.answerId || !data.userId) {
              break;
            }

            setSuggestions(prev => {
              const next: SuggestionsByAnswerId = { ...prev };

              // Remove this user's previous suggestion from all answers
              Object.keys(next).forEach(answerId => {
                next[answerId] = next[answerId].filter(
                  s => s.userId !== data.userId
                );
                if (!next[answerId].length) {
                  delete next[answerId];
                }
              });

              const list = next[data.answerId] || [];
              next[data.answerId] = [
                ...list,
                {
                  userId: data.userId,
                  username: data.username,
                },
              ];

              return next;
            });
            break;
          }

          case 'team_answer_finalized':
            // Our team has locked in an answer. Lock the question and show
            // a waiting overlay until the server sends results.
            setTeamAnswer(data.finalAnswer.answerId);
            setHasSubmitted(true);
            setWaitingForResults(true);
            break;

          case 'team_battle_question_results': {
            // Both teams have been evaluated for this question.
            setWaitingForResults(false);

            const correctId: string | null = data.correctAnswer?.id || null;
            setCorrectAnswerId(correctId);

            const resolvedPlayerTeamId =
              gameStateRef.current.playerTeam?.id ||
              gameStateRef.current.teams?.find(team =>
                team.members.some(member => member.userId === user?.id)
              )?.id;
            const playerTeamResult = data.teamResults?.find(
              (r: any) => r.teamId === resolvedPlayerTeamId
            );
            const roundCorrect = !!playerTeamResult?.correct;
            setLastRoundCorrect(roundCorrect);
            console.log('Team answer was', roundCorrect ? 'CORRECT' : 'INCORRECT');

            setGameState(prev => {
              let updatedTeams = prev.teams;

              if (prev.teams && data.leaderboard) {
                updatedTeams = prev.teams.map(team => {
                  const lb = data.leaderboard.find(
                    (entry: any) => entry.teamId === team.id
                  );
                  return lb ? { ...team, score: lb.score } : team;
                });
              }

              const playerTeam = updatedTeams?.find(team =>
                team.members.some(member => member.userId === user?.id)
              );
              const opposingTeam = updatedTeams?.find(
                team => team.id !== playerTeam?.id
              );

              return {
                ...prev,
                teams: updatedTeams,
                playerTeam: playerTeam || prev.playerTeam,
                opposingTeam: opposingTeam || prev.opposingTeam,
              };
            });

            break;
          }

          case 'team_battle_round_complete':
            // Show round results
            toast({
              title: 'Round Complete',
              description: `Your team ${data.yourTeamCorrect ? 'got it right' : 'got it wrong'}!`,
            });
            break;

          case 'team_battle_finished':
          case 'team_battle_ended':
            setGameState(prev => ({
              ...prev,
              phase: 'finished',
              teams: data.finalScores,
              finalScore: data.yourTeam?.score ?? prev.finalScore ?? 0,
              correct: data.yourTeam?.correctAnswers ?? prev.correct ?? 0,
              incorrect: data.yourTeam?.incorrectAnswers ?? prev.incorrect ?? 0,
            }));
            setShowRoundFeedback(false);
            toast({
              title: 'Battle Finished!',
              description: data.winner ? `${data.winner.name} wins!` : "It's a draw!",
            });
            break;

          case 'teams_updated':
          case 'team_update':
            if (data.teams) {
              updateTeamsData(data.teams);
            }
            break;

          case 'error':
            toast({
              title: 'Error',
              description: data.message,
              variant: 'destructive',
            });
            break;
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
      }
    };

    socket.addEventListener('message', handleMessage);

    // Cleanup
    return () => {
      socket.removeEventListener('message', handleMessage);
    };
  }, [user, gameSessionId]);

  useEffect(() => {
    initSounds();
  }, []);

  useEffect(() => {
    console.log(gameState, 'gameState');
  }, [gameState]);

  const updateGameState = (data: any) => {
    setGameState(prev => ({
      ...prev,
      ...data.gameState,
      playerTeam: data.playerTeam,
      opposingTeam: data.opposingTeam,
    }));
  };

  const updateTeamsData = (teams: Team[]) => {
    const playerTeam = teams.find(team =>
      team.members.some(member => member.userId === user?.id)
    );
    const opposingTeam = teams.find(team => team.id !== playerTeam?.id);

    setGameState(prev => ({
      ...prev,
      teams,
      playerTeam,
      opposingTeam,
    }));
  };

  const handleMemberSelect = (answerId: string) => {
    if (!gameState.currentQuestion || !gameState.playerTeam || !user) return;

    sendGameEvent({
      type: 'team_option_selected',
      teamId: gameState.playerTeam.id,
      questionId: gameState.currentQuestion.id,
      answerId,
      userId: user.id,
      username: user.username,
    });

    setSelectedAnswer(answerId);
  };

  const handleCaptainSubmit = (answerId: string) => {
    if (!gameState.currentQuestion || !gameState.playerTeam) return;
    if (!isTeamCaptain()) return;

    sendGameEvent({
      type: 'finalize_team_answer',
      teamId: gameState.playerTeam.id,
      finalAnswer: {
        questionId: gameState.currentQuestion.id,
        answerId,
      },
    });
  };

  const isTeamCaptain = () => {
    return gameState.playerTeam?.captainId === user?.id;
  };

  const renderWaitingPhase = () => (
  <div className="max-w-xl mx-auto p-6">
    <Card className="bg-gradient-to-b from-[#0F1624] to-[#0A0F1A] text-white rounded-3xl shadow-2xl border border-white/10 px-6 py-10">

      {/* Title */}
      <h1 className="text-center text-3xl font-bold tracking-wide mb-4">
        Getting Things Ready
      </h1>

      {/* Subtext */}
      <p className="text-center text-white/70 text-sm mb-10">
        Please wait while we prepare your first question...
      </p>

      {/* Loading Dot Animation */}
      <div className="flex justify-center gap-2 mt-4">
        <div className="h-3 w-3 rounded-full bg-yellow-400 animate-bounce"></div>
        <div className="h-3 w-3 rounded-full bg-yellow-500 animate-bounce delay-150"></div>
        <div className="h-3 w-3 rounded-full bg-yellow-600 animate-bounce delay-300"></div>
      </div>
      
    </Card>
  </div>
);


  const renderQuestionPhase = () => {
    if (!gameState.currentQuestion || !gameState.playerTeam) return null;

    const question = gameState.currentQuestion;
    const timeLimit = 15;
    const timeRemaining = Math.min(
      gameState.timeRemaining ?? timeLimit,
      timeLimit
    );

    return (
      <div className="max-w-5xl mx-auto p-6 relative bg-gradient-to-br from-secondary to-secondary-dark text-white">
        <TeamBattleQuestionBoard
          question={{ id: question.id, text: question.text }}
          answers={question.answers.map(a => ({ id: a.id, text: a.text }))}
          timeRemaining={timeRemaining}
          timeLimit={timeLimit}
          score={gameState.playerTeam.score}
          totalQuestions={gameState.totalQuestions || 1}
          currentQuestionIndex={(gameState.questionNumber || 1) - 1}
          category={question.category}
          difficultyLabel={question.difficulty}
          isCaptain={isTeamCaptain()}
          isQuestionLocked={Boolean(teamAnswer)}
          suggestions={suggestions}
          onMemberSelect={handleMemberSelect}
          onCaptainSubmit={handleCaptainSubmit}
        />

        {waitingForResults && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
            <Card className="max-w-sm w-full mx-4 bg-gradient-to-br from-secondary to-secondary-dark text-white border border-accent/60 shadow-2xl">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5" />
                  Waiting for Opponent
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-white/80">
                  Your team answer is locked in. Waiting for the other team to submit
                  their answer. After both teams have answered, the correct answer will be shown.
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    );
  };

  const renderResultsPhase = () => {
    if (!gameState.currentQuestion) return null;

    const question = gameState.currentQuestion;
    const correctAnswer =
      correctAnswerId && question.answers.find(a => a.id === correctAnswerId);
    const yourAnswer =
      teamAnswer && question.answers.find(a => a.id === teamAnswer);

    return (
      <div className="max-w-4xl mx-auto p-6">
        <Card className="bg-gradient-to-br from-secondary to-secondary-dark text-white border border-accent/40 shadow-2xl">
          <CardHeader>
            <CardTitle>Round Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="font-semibold mb-1 text-accent-light">Question</p>
              <p className="text-white/90">{question.text}</p>
            </div>

            <div>
              <p className="font-semibold mb-1 text-accent-light">Correct Answer</p>
              <p className="text-green-300">{correctAnswer ? correctAnswer.text : 'Not available'}</p>
            </div>

            <div>
              <p className="font-semibold mb-1 text-accent-light">Your Team's Answer</p>
              <p className="text-white/90">{yourAnswer ? yourAnswer.text : 'No answer submitted'}</p>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button
                onClick={() => {
                  // Do not modify result state here; wait for the server to
                  // send the next team_battle_question.
                }}
                className="bg-gradient-to-r from-accent to-accent-dark text-primary hover:from-accent-light hover:to-accent font-bold"
              >
                Continue
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  };

  const renderFinishedPhase = () => {
    const teams = gameState.teams || [];

    // Determine your team and the opposing team from the final scores
    const yourTeamFromScores = teams.find(
      (team) => team.id === gameState.playerTeam?.id
    );
    const opponentFromScores = teams.find(
      (team) => team.id !== gameState.playerTeam?.id
    );

    const yourTeam = yourTeamFromScores || gameState.playerTeam || teams[0];
    const opponentTeam = opponentFromScores || gameState.opposingTeam || teams[1];

    return (
      <div className="max-w-xl mx-auto p-6">
        <Card className="bg-gradient-to-b from-[#0F1624] to-[#0A0F1A] text-white rounded-3xl shadow-2xl border border-white/10 px-6 py-10">
          {/* Top Score Circle */}
          <div className="flex justify-center mb-6">
            <div className="h-20 w-20 rounded-full bg-gradient-to-b from-yellow-400 to-yellow-600 flex items-center justify-center shadow-lg">
              <span className="text-3xl font-bold">
                {gameState.teams?.[0]?.score ?? 0}
              </span>
            </div>
          </div>

          {/* Title */}
          <h1 className="text-center text-4xl font-extrabold tracking-wide mb-8">
            GAME OVER!
          </h1>

          {/* Stats Box - both teams */}
          <div className="bg-white/5 rounded-2xl p-6 border border-white/10 mb-10">
            {yourTeam && (
              <div className="space-y-4">
                <div className="text-center text-sm font-semibold text-white/80 uppercase tracking-wide">
                  {yourTeam.name || 'Your Team'}
                </div>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="bg-black/30 rounded-xl py-4 border border-white/10">
                    <div className="text-3xl font-bold text-yellow-400">
                      {yourTeam.score ?? 0}
                    </div>
                    <div className="text-sm text-white/70 mt-1">Final Score</div>
                  </div>

                  <div className="bg-black/30 rounded-xl py-4 border border-white/10">
                    <div className="text-3xl font-bold text-green-400">
                      {yourTeam.correctAnswers ?? 0}
                    </div>
                    <div className="text-sm text-white/70 mt-1">Correct</div>
                  </div>

                  <div className="bg-black/30 rounded-xl py-4 border border-white/10">
                    <div className="text-3xl font-bold text-red-400">
                      {yourTeam.incorrectAnswers ?? 0}
                    </div>
                    <div className="text-sm text-white/70 mt-1">Incorrect</div>
                  </div>
                </div>

                {opponentTeam && (
                  <>
                    <div className="h-px bg-white/10 my-2" />
                    <div className="text-center text-sm font-semibold text-white/80 uppercase tracking-wide">
                      {opponentTeam.name || 'Opponent Team'}
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div className="bg-black/30 rounded-xl py-4 border border-white/10">
                        <div className="text-3xl font-bold text-yellow-400">
                          {opponentTeam.score ?? 0}
                        </div>
                        <div className="text-sm text-white/70 mt-1">Final Score</div>
                      </div>

                      <div className="bg-black/30 rounded-xl py-4 border border-white/10">
                        <div className="text-3xl font-bold text-green-400">
                          {opponentTeam.correctAnswers ?? 0}
                        </div>
                        <div className="text-sm text-white/70 mt-1">Correct</div>
                      </div>

                      <div className="bg-black/30 rounded-xl py-4 border border-white/10">
                        <div className="text-3xl font-bold text-red-400">
                          {opponentTeam.incorrectAnswers ?? 0}
                        </div>
                        <div className="text-sm text-white/70 mt-1">Incorrect</div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-center gap-4">
            <Button
              onClick={() => setLocation('/')}
              className="bg-white/10 border border-white/20 text-white px-6 py-3 rounded-xl hover:bg-white/20 shadow-lg"
            >
              Home
            </Button>
          </div>
        </Card>
      </div>
    );
  };

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card>
          <CardContent className="p-6">
            <p>Please log in to access the team battle.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!gameSessionId) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card>
          <CardContent className="p-6">
            <p>Invalid game session. Please return to the home page.</p>
            <Button className="mt-4" onClick={() => setLocation('/') }>
              Go Home
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const showFeedbackModal =
    showRoundFeedback &&
    gameState.currentQuestion &&
    correctAnswerId !== null &&
    lastRoundCorrect !== null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-black via-primary-dark to-black text-white relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4">
        <GameHeader
          soundEnabled={soundEnabled}
          setSoundEnabled={setSoundEnabled}
          voiceEnabled={voiceEnabled}
          setVoiceEnabled={setVoiceEnabled}
        />
      </div>
      {(gameState.phase === 'waiting' || (gameState.phase === 'playing' && !gameState.currentQuestion)) && renderWaitingPhase()}
      {gameState.phase === 'question' && renderQuestionPhase()}
      {gameState.phase === 'results' && renderResultsPhase()}
      {gameState.phase === 'finished' && renderFinishedPhase()}

      {showFeedbackModal && gameState.currentQuestion && (
        <FeedbackModal
          isCorrect={lastRoundCorrect == true}
          question={gameState.currentQuestion.text}
          correctAnswer={
            gameState.currentQuestion.answers.find(
              (a) => a.id === correctAnswerId
            )?.text || ''
          }
          avatarMessage={
            lastRoundCorrect === true
              ? 'Amen! That\'s correct! Wonderful teamwork.'
              : 'A brave attempt, but fear not, for wisdom grows with each question.'
          }
          onClose={() => {
            setShowRoundFeedback(false);
            setLastRoundCorrect(null);
            setCorrectAnswerId(null);
          }}
        />
      )}
    </div>
  );
}