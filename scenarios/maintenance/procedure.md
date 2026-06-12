# 预约保养业务 Procedure

用户发起保养预约时，先确认本次要保养的车辆。客户名下只有一辆车时，可以直接使用该车辆；客户名下有多辆车，或仅能根据历史记录推测可能需要保养的车辆时，必须让用户确认，不替用户猜测。

流程开始后，尽早读取客户资料、名下车辆和最近使用门店，分别使用 {@connectors.maintenance.getCustomer}、{@connectors.maintenance.getUserVehicles}、{@connectors.maintenance.getRecentDealer}。用户说“还是上次那家店”时，优先使用最近使用门店；否则根据本次车辆查询可选门店，使用 {@connectors.maintenance.getDealerCandidates}，并让用户确认具体 4S 店。

用户需要给出期望到店时间，可以是“明天下午”“下周三上午”这类自然语言时间。系统将其转换为可查询的时间范围。车辆、门店或期望时间发生变化时，已选择的到店时段和未确认的预约草稿都需要作废，并基于新的信息重新查询和生成。

本流程不判断、不确认服务项目，也不报价；服务项目由后续独立 procedure 处理。用户追问服务项目或费用时，只说明当前预约流程先确认车辆、门店和到店时间。

当车辆、门店和期望时间都确定后，通过 {@connectors.maintenance.getAvailableSlots} 查询门店可预约时段。系统只向用户展示可选到店时间，由用户选择并确认具体时段；维修工位属于门店排班资源，不作为用户需要确认的业务信息。

用户确认具体到店时段后，通过 {@connectors.maintenance.createBookingDraft} 创建预约草稿。草稿只代表待确认方案，需向用户展示车辆、门店和到店时间，不能直接提交。

只有用户明确确认预约草稿后，才通过 {@connectors.maintenance.confirmBooking} 提交正式预约并返回成功信息。用户提出取消时，停止继续推进当前预约；如果已有正式预约，再进入取消预约处理，否则说明当前没有可取消的正式预约。
