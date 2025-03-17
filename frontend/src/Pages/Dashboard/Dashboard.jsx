import { useState } from "react";
import { Layout, Typography, Input, Button, Form, Card, Alert, Space, Table, Tag, Modal } from "antd";

const { Content } = Layout;
const { Title, Link } = Typography;

export default function DeployDashboard() {
  const [githubUrl, setGithubUrl] = useState("");
  const [deployments, setDeployments] = useState([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [error, setError] = useState(null);
  const [statusModal, setStatusModal] = useState({ visible: false, deployment: null });

  const API_URL = import.meta.env.VITE_API_URL;

  function handleInputChange(e) {
    setGithubUrl(e.target.value);
    setError(null);
  }

  async function handleDeploy() {
    if (!githubUrl) {
      setError("Please enter a GitHub URL");
      return;
    }

    setError(null);
    setIsDeploying(true);

    try {
      const response = await fetch(`${API_URL}/url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: githubUrl }),
      });

      if (!response.ok) {
        throw new Error(`Deployment failed with status: ${response.status}`);
      }

      const data = await response.json();
      const newDeployment = {
        key: Date.now(),
        githubUrl,
        trackingUrl: data.userTrackingUrl,
        status: "processing",
        deployedUrl: null,
        timestamp: new Date().toLocaleString(),
        checkingStatus: false,
      };

      setDeployments((prev) => [newDeployment, ...prev]);
      setGithubUrl("");
    } catch (error) {
      console.error("Deployment error:", error);
      setError("Failed to start deployment. Please check the URL and try again.");
    } finally {
      setIsDeploying(false);
    }
  }

  async function checkDeploymentStatus(deployment) {
    // Find the deployment to update
    const updatedDeployments = [...deployments];
    const index = updatedDeployments.findIndex((d) => d.key === deployment.key);

    // Set loading state for this specific deployment
    updatedDeployments[index] = { ...deployment, checkingStatus: true };
    setDeployments(updatedDeployments);

    try {
      const response = await fetch(deployment.trackingUrl);
      const data = await response.json();

      // Update deployment with new status
      updatedDeployments[index] = {
        ...deployment,
        status: data.msg,
        deployedUrl: data.redirectUrl !== "still processing" ? data.redirectUrl : null,
        checkingStatus: false,
      };
    } catch (error) {
      console.error("Status check failed:", error);
      updatedDeployments[index].checkingStatus = false;
    }

    // Update deployments list with final state
    setDeployments([...updatedDeployments]);
  }

  const columns = [
    {
      title: "Time",
      dataIndex: "timestamp",
      width: "15%",
    },
    {
      title: "GitHub URL",
      dataIndex: "githubUrl",
      width: "25%",
      ellipsis: true,
    },
    {
      title: "Status",
      dataIndex: "status",
      width: "20%",
      render: (status) => (
        <Tag
          color={
            status === "processing"
              ? "blue"
              : status === "repo cloned sucessefully"
              ? "cyan"
              : status === "repo built sucessfully"
              ? "orange"
              : status === "repo deployed sucessfully"
              ? "green"
              : "red"
          }
        >
          {status}
        </Tag>
      ),
    },
    {
      title: "Deployed URL",
      dataIndex: "deployedUrl",
      width: "25%",
      render: (url) =>
        url ? (
          <Link href={url} target="_blank">
            {url}
          </Link>
        ) : (
          "-"
        ),
    },
    {
      title: "Actions",
      width: "15%",
      render: (_, deployment) => (
        <Space>
          <Button size="small" onClick={() => checkDeploymentStatus(deployment)} loading={deployment.checkingStatus}>
            Check Status
          </Button>
          <Button size="small" onClick={() => setStatusModal({ visible: true, deployment })}>
            Details
          </Button>
        </Space>
      ),
    },
  ];

  function DeploymentSteps({ status }) {
    const steps = [
      { step: "Processing", status: "processing" },
      { step: "Repo Cloned", status: "repo cloned sucessefully" },
      { step: "Build Complete", status: "repo built sucessfully" },
      { step: "Deployment Complete", status: "repo deployed sucessfully" },
    ];

    return (
      <div style={{ padding: "20px 0" }}>
        {steps.map((item, index) => (
          <div
            key={index}
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: "10px",
              opacity: steps.findIndex((s) => s.status === status) >= index ? 1 : 0.5,
            }}
          >
            <div
              style={{
                width: "24px",
                height: "24px",
                borderRadius: "50%",
                backgroundColor: steps.findIndex((s) => s.status === status) >= index ? "#1890ff" : "#d9d9d9",
                color: "white",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginRight: "10px",
              }}
            >
              {index + 1}
            </div>
            <span>{item.step}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <Layout style={{ minHeight: "100vh", background: "#f0f2f5" }}>
      <Content style={{ padding: "24px" }}>
        <Card style={{ marginBottom: 24 }}>
          <Title level={2} style={{ textAlign: "center", marginBottom: 24 }}>
            Deploy React Apps
          </Title>

          <Form layout="vertical">
            <Form.Item label="GitHub Repository URL:" required validateStatus={error ? "error" : ""} help={error}>
              <Space.Compact style={{ width: "100%", display: "flex" }}>
                <Input value={githubUrl} onChange={handleInputChange} placeholder="https://github.com/username/repo" size="large" />
                <Button type="primary" onClick={handleDeploy} loading={isDeploying} size="large">
                  Deploy
                </Button>
              </Space.Compact>
            </Form.Item>
          </Form>
        </Card>

        <Card title="Deployment History">
          <Table columns={columns} dataSource={deployments} pagination={{ pageSize: 5 }} scroll={{ x: true }} />
        </Card>

        <Modal title="Deployment Progress" open={statusModal.visible} onCancel={() => setStatusModal({ visible: false, deployment: null })} footer={null} width={500}>
          {statusModal.deployment && (
            <div>
              <p>
                <strong>Repository:</strong> {statusModal.deployment.githubUrl}
              </p>
              <p>
                <strong>Started:</strong> {statusModal.deployment.timestamp}
              </p>
              <DeploymentSteps status={statusModal.deployment.status} />
              {statusModal.deployment.deployedUrl && (
                <p>
                  <strong>Live URL:</strong>{" "}
                  <Link href={statusModal.deployment.deployedUrl} target="_blank">
                    {statusModal.deployment.deployedUrl}
                  </Link>
                </p>
              )}
            </div>
          )}
        </Modal>
      </Content>
    </Layout>
  );
}
