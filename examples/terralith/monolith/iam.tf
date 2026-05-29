resource "aws_iam_role" "eks_cluster" {
  name               = "eks-cluster-role"
  assume_role_policy = "{}"
}

resource "aws_iam_role" "eks_node" {
  name               = "eks-node-role"
  assume_role_policy = "{}"
}

resource "aws_iam_role" "lambda_api" {
  name               = "lambda-api-role"
  assume_role_policy = "{}"
}

resource "aws_iam_role" "lambda_events" {
  name               = "lambda-events-role"
  assume_role_policy = "{}"
}

resource "aws_iam_role" "lambda_data" {
  name               = "lambda-data-role"
  assume_role_policy = "{}"
}

resource "aws_iam_role" "ecs_task" {
  name               = "ecs-task-role"
  assume_role_policy = "{}"
}
