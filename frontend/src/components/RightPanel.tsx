import React from 'react';
import OsintStream from './OsintStream';
import AgentMessages from './AgentMessages';

interface Alert {
  id: number;
  message: string;
  level: 'high' | 'medium' | 'low' | 'info';
  time: string;
}

interface RightPanelProps {
  alerts: Alert[];
}

export default function RightPanel({ alerts }: RightPanelProps) {
  // 获取警报颜色
  const getAlertColor = (level: string) => {
    switch (level) {
      case 'high': return 'bg-red-500';
      case 'medium': return 'bg-yellow-500';
      case 'low': return 'bg-blue-500';
      case 'info': return 'bg-green-500';
      default: return 'bg-gray-500';
    }
  };

  return (
    <div className="col-span-3 flex flex-col gap-2 md:gap-4">
      {/* 上部：跨源信号 */}
      <div className="border border-[#1E293B] bg-slate-900/50 backdrop-blur-sm rounded-sm p-2 md:p-4 flex flex-col">
        <h2 className="text-[12px] md:text-sm font-bold text-cyan-400 mb-1.5 md:mb-2">CROSS-SOURCE SIGNALS</h2>
        <div className="space-y-2 md:space-y-3 flex-1 overflow-y-auto">
          {alerts.map(alert => (
            <div key={alert.id} className="border-l-2" style={{ borderColor: getAlertColor(alert.level) }}>
              <div className="ml-1.5 md:ml-2">
                <div className="flex justify-between items-start gap-2">
                  <span className="text-[12px] md:text-xs">{alert.message}</span>
                  <span className="text-[12px] md:text-xs text-gray-400 shrink-0">{alert.time}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 下部：实时情报流 */}
      <OsintStream />

      {/* Agent 消息 */}
      <AgentMessages />
    </div>
  );
}
